package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
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

func converter(bucketTipo string, ev awEvento) eventoLote {
	e := eventoLote{Bucket: bucketTipo, Inicio: ev.Timestamp, DuracaoSeg: ev.Duration}
	switch bucketTipo {
	case "janela":
		e.App = str(ev.Data, "app")
		e.Titulo = str(ev.Data, "title")
	case "afk":
		v := str(ev.Data, "status") == "afk"
		e.Afk = &v
	case "web":
		e.URL = str(ev.Data, "url")
		e.Titulo = str(ev.Data, "title")
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

func (c *Coletor) eventosDesde(ctx context.Context, id string, desde time.Time) ([]awEvento, error) {
	q := url.Values{}
	q.Set("start", desde.UTC().Format(time.RFC3339))
	q.Set("limit", "5000")
	var evs []awEvento
	err := c.getJSON(ctx, c.AwURL+"/api/0/buckets/"+url.PathEscape(id)+"/events?"+q.Encode(), &evs)
	return evs, err
}
