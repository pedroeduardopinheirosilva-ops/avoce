package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Limites de tamanho dos campos — os mesmos que o servidor aplica em ingest.ts.
const (
	maxApp    = 300
	maxTitulo = 500
	maxURL    = 1000
	limiteAW  = 5000 // eventos por página na API do aw-server
)

type awBucket struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Hostname string `json:"hostname"`
}

type awEvento struct {
	ID        int64          `json:"id"`
	Timestamp string         `json:"timestamp"`
	Duration  float64        `json:"duration"`
	Data      map[string]any `json:"data"`
}

// mapearBuckets devolve id → "janela"|"afk"|"web"; tipos desconhecidos são ignorados.
func mapearBuckets(lista map[string]awBucket) map[string]string {
	out := map[string]string{}
	for id, b := range lista {
		switch b.Type {
		case "currentwindow":
			out[id] = "janela"
		case "afkstatus":
			out[id] = "afk"
		case "web.tab.current":
			out[id] = "web"
		}
	}
	return out
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// cortar limita s a n caracteres (runas), sem quebrar UTF-8.
func cortar(s string, n int) string {
	if len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func converter(bucketTipo string, ev awEvento) eventoLote {
	e := eventoLote{Bucket: bucketTipo, Inicio: ev.Timestamp, DuracaoSeg: ev.Duration}
	switch bucketTipo {
	case "janela":
		e.App = cortar(str(ev.Data, "app"), maxApp)
		e.Titulo = cortar(str(ev.Data, "title"), maxTitulo)
	case "afk":
		v := str(ev.Data, "status") == "afk"
		e.Afk = &v
	case "web":
		e.URL = cortar(str(ev.Data, "url"), maxURL)
		e.Titulo = cortar(str(ev.Data, "title"), maxTitulo)
	}
	return e
}

func (c *Coletor) getJSON(ctx context.Context, u string, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("aw-server respondeu %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

func (c *Coletor) listarBuckets(ctx context.Context) (map[string]string, error) {
	var lista map[string]awBucket
	if err := c.getJSON(ctx, c.AwURL+"/api/0/buckets/", &lista); err != nil {
		return nil, err
	}
	return mapearBuckets(lista), nil
}

// eventosDesde lê todos os eventos do bucket a partir de `desde`. O aw-server devolve
// os `limit` eventos MAIS NOVOS (do mais novo para o mais antigo); por isso, enquanto
// uma página vier cheia, pede a próxima com `end` = timestamp mais antigo da página,
// descartando os repetidos da fronteira. A ordem do resultado não é garantida.
func (c *Coletor) eventosDesde(ctx context.Context, id string, desde time.Time) ([]awEvento, error) {
	return c.eventosPaginados(ctx, id, desde, limiteAW)
}

func (c *Coletor) eventosPaginados(ctx context.Context, id string, desde time.Time, limite int) ([]awEvento, error) {
	vistos := map[string]bool{}
	var todos []awEvento
	fim := ""
	for {
		q := url.Values{}
		q.Set("start", desde.UTC().Format(time.RFC3339))
		if fim != "" {
			q.Set("end", fim)
		}
		q.Set("limit", fmt.Sprint(limite))
		var pagina []awEvento
		if err := c.getJSON(ctx, c.AwURL+"/api/0/buckets/"+url.PathEscape(id)+"/events?"+q.Encode(), &pagina); err != nil {
			return nil, err
		}
		novos := 0
		var maisAntigo time.Time
		for _, ev := range pagina {
			t, err := time.Parse(time.RFC3339Nano, ev.Timestamp)
			if err != nil {
				continue
			}
			if maisAntigo.IsZero() || t.Before(maisAntigo) {
				maisAntigo = t
			}
			chave := t.UTC().Format(time.RFC3339Nano)
			if vistos[chave] {
				continue
			}
			vistos[chave] = true
			todos = append(todos, ev)
			novos++
		}
		// Página incompleta = acabou; página só com repetidos = não há como avançar.
		if len(pagina) < limite || novos == 0 || maisAntigo.IsZero() {
			return todos, nil
		}
		fim = maisAntigo.UTC().Format(time.RFC3339Nano)
	}
}
