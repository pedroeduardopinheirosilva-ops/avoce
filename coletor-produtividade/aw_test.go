package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMapearBuckets(t *testing.T) {
	m := mapearBuckets(map[string]awBucket{
		"aw-watcher-window_PC":     {ID: "aw-watcher-window_PC", Type: "currentwindow"},
		"aw-watcher-afk_PC":        {ID: "aw-watcher-afk_PC", Type: "afkstatus"},
		"aw-watcher-web-chrome_PC": {ID: "aw-watcher-web-chrome_PC", Type: "web.tab.current"},
		"outro":                    {ID: "outro", Type: "app.editor.activity"},
	})
	esperado := map[string]string{
		"aw-watcher-window_PC":     "janela",
		"aw-watcher-afk_PC":        "afk",
		"aw-watcher-web-chrome_PC": "web",
	}
	if len(m) != 3 {
		t.Fatalf("esperava 3 buckets, veio %v", m)
	}
	for k, v := range esperado {
		if m[k] != v {
			t.Errorf("%s: esperava %s, veio %s", k, v, m[k])
		}
	}
}

// ---- helpers de teste ----

type fakeAvoce struct {
	mu     sync.Mutex
	lotes  []LoteIngest
	status int
	auth   []string
	srv    *httptest.Server
}

func novoAvoce(t *testing.T, status int) *fakeAvoce {
	f := &fakeAvoce{status: status}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var l LoteIngest
		_ = json.Unmarshal(b, &l)
		f.mu.Lock()
		f.lotes = append(f.lotes, l)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		st := f.status
		f.mu.Unlock()
		w.WriteHeader(st)
		_, _ = w.Write([]byte(`{"gravados":0}`))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// filtrarAW imita a API de eventos do aw-server: start/end filtram por timestamp e
// voltam os `limit` eventos MAIS NOVOS, do mais novo para o mais antigo.
func filtrarAW(t *testing.T, eventos []awEvento, r *http.Request) []awEvento {
	q := r.URL.Query()
	var ini, fim time.Time
	if s := q.Get("start"); s != "" {
		ini, _ = time.Parse(time.RFC3339Nano, s)
	}
	if s := q.Get("end"); s != "" {
		fim, _ = time.Parse(time.RFC3339Nano, s)
	}
	out := []awEvento{}
	for _, e := range eventos {
		ts, err := time.Parse(time.RFC3339Nano, e.Timestamp)
		if err != nil {
			t.Errorf("timestamp inválido no mock: %v", err)
			continue
		}
		if !ini.IsZero() && ts.Before(ini) {
			continue
		}
		if !fim.IsZero() && ts.After(fim) {
			continue
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp > out[j].Timestamp })
	if lim, _ := strconv.Atoi(q.Get("limit")); lim > 0 && len(out) > lim {
		out = out[:lim]
	}
	return out
}

// novoAW simula o aw-server com um bucket de janela e os eventos dados.
func novoAW(t *testing.T, eventos []awEvento) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/0/buckets/" {
			_ = json.NewEncoder(w).Encode(map[string]awBucket{
				"aw-watcher-window_PC": {ID: "aw-watcher-window_PC", Type: "currentwindow"},
			})
			return
		}
		if r.URL.Path == "/api/0/buckets/aw-watcher-window_PC/events" {
			_ = json.NewEncoder(w).Encode(filtrarAW(t, eventos, r))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func novoColetor(t *testing.T, aw, avoce string) *Coletor {
	return &Coletor{
		AwURL:    aw,
		AvoceURL: avoce,
		Token:    "tok123",
		Dir:      t.TempDir(),
		HTTP:     &http.Client{Timeout: 5 * time.Second},
		Agora:    func() time.Time { return time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC) },
		Log:      log.New(io.Discard, "", 0),
		So:       "mac",
		Versao:   "teste",
	}
}

func evs(n int, base time.Time) []awEvento {
	out := make([]awEvento, n)
	for i := 0; i < n; i++ {
		out[i] = awEvento{
			Timestamp: base.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano),
			Duration:  1.5,
			Data:      map[string]any{"app": "Code", "title": fmt.Sprintf("arq%d", i)},
		}
	}
	return out
}

func TestConverter(t *testing.T) {
	e := converter("janela", awEvento{Timestamp: "2026-11-13T10:00:00Z", Duration: 2.5, Data: map[string]any{"app": "Excel", "title": "plan"}})
	if e.Bucket != "janela" || e.App != "Excel" || e.Titulo != "plan" || e.DuracaoSeg != 2.5 || e.Inicio != "2026-11-13T10:00:00Z" {
		t.Errorf("janela: %+v", e)
	}
	a := converter("afk", awEvento{Data: map[string]any{"status": "afk"}})
	if a.Afk == nil || !*a.Afk {
		t.Errorf("afk deveria ser true: %+v", a)
	}
	n := converter("afk", awEvento{Data: map[string]any{"status": "not-afk"}})
	if n.Afk == nil || *n.Afk {
		t.Errorf("not-afk deveria ser false: %+v", n)
	}
	w := converter("web", awEvento{Data: map[string]any{"url": "https://x.com", "title": "X"}})
	if w.URL != "https://x.com" || w.Titulo != "X" {
		t.Errorf("web: %+v", w)
	}
}

func TestCicloEnviaEAvancaEstado(t *testing.T) {
	base := time.Date(2026, 11, 13, 11, 0, 0, 0, time.UTC)
	e := evs(3, base)
	aw := novoAW(t, e)
	av := novoAvoce(t, 200)
	c := novoColetor(t, aw.URL, av.srv.URL)
	if err := c.ciclo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(av.lotes) != 1 || len(av.lotes[0].Eventos) != 3 {
		t.Fatalf("lotes: %+v", av.lotes)
	}
	if av.auth[0] != "Bearer tok123" {
		t.Errorf("auth: %q", av.auth[0])
	}
	if av.lotes[0].Versao != "teste" || av.lotes[0].So != "mac" {
		t.Errorf("versao/so: %+v", av.lotes[0])
	}
	est := c.carregarEstado()
	got, err := time.Parse(time.RFC3339Nano, est["aw-watcher-window_PC"])
	if err != nil || !got.Equal(base.Add(2*time.Second)) {
		t.Errorf("estado: %v (%v)", est, err)
	}
}

func TestFalhaNoAvoceNaoAvancaEstado(t *testing.T) {
	aw := novoAW(t, evs(3, time.Date(2026, 11, 13, 11, 0, 0, 0, time.UTC)))
	av := novoAvoce(t, 500)
	c := novoColetor(t, aw.URL, av.srv.URL)
	antes := map[string]string{"aw-watcher-window_PC": "2026-11-13T10:00:00Z"}
	if err := c.salvarEstado(antes); err != nil {
		t.Fatal(err)
	}
	_ = c.ciclo(context.Background())
	depois := c.carregarEstado()
	if depois["aw-watcher-window_PC"] != antes["aw-watcher-window_PC"] {
		t.Errorf("estado mudou: %v", depois)
	}
}

func TestDivideEmLotes(t *testing.T) {
	aw := novoAW(t, evs(1200, time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)))
	av := novoAvoce(t, 200)
	c := novoColetor(t, aw.URL, av.srv.URL)
	if err := c.ciclo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(av.lotes) != 3 {
		t.Fatalf("esperava 3 POSTs, veio %d", len(av.lotes))
	}
	for i, n := range []int{500, 500, 200} {
		if len(av.lotes[i].Eventos) != n {
			t.Errorf("lote %d: %d", i, len(av.lotes[i].Eventos))
		}
	}
}

func TestPaginaQuandoHaMaisQueOLimiteDoAW(t *testing.T) {
	// 12 000 eventos desde o ponteiro: o aw-server só devolve 5000 por vez (os mais novos).
	ponteiro := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	base := ponteiro.Add(sobreposicao) // todos depois do ponteiro−sobreposição
	e := evs(12000, base)
	aw := novoAW(t, e)
	av := novoAvoce(t, 200)
	c := novoColetor(t, aw.URL, av.srv.URL)
	if err := c.salvarEstado(map[string]string{"aw-watcher-window_PC": ponteiro.Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	if err := c.ciclo(context.Background()); err != nil {
		t.Fatal(err)
	}
	vistos := map[string]int{}
	var ordem []string
	for _, l := range av.lotes {
		for _, ev := range l.Eventos {
			vistos[ev.Inicio]++
			ordem = append(ordem, ev.Inicio)
		}
	}
	if len(vistos) != 12000 || len(ordem) != 12000 {
		t.Fatalf("esperava 12000 eventos únicos enviados uma vez, veio %d únicos / %d enviados", len(vistos), len(ordem))
	}
	if !sort.StringsAreSorted(ordem) {
		t.Error("eventos deveriam ir do mais antigo para o mais novo")
	}
	got, _ := time.Parse(time.RFC3339Nano, c.carregarEstado()["aw-watcher-window_PC"])
	if !got.Equal(base.Add(11999 * time.Second)) {
		t.Errorf("estado deveria estar no maior timestamp, veio %v", got)
	}
}

func TestPaginacaoParaSemProgresso(t *testing.T) {
	// 3 eventos com o mesmo timestamp e limite 2: não pode entrar em laço infinito.
	ts := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	e := []awEvento{{Timestamp: ts}, {Timestamp: ts}, {Timestamp: ts}}
	aw := novoAW(t, e)
	c := novoColetor(t, aw.URL, "")
	got, err := c.eventosPaginados(context.Background(), "aw-watcher-window_PC", time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC), 2)
	if err != nil || len(got) != 1 {
		t.Fatalf("esperava 1 evento (dedupe), veio %d (%v)", len(got), err)
	}
}

func TestConverterCortaCamposNoLimiteDoServidor(t *testing.T) {
	grande := strings.Repeat("é", 3000)
	j := converter("janela", awEvento{Data: map[string]any{"app": grande, "title": grande}})
	if n := len([]rune(j.App)); n != maxApp {
		t.Errorf("app: %d", n)
	}
	if n := len([]rune(j.Titulo)); n != maxTitulo {
		t.Errorf("titulo: %d", n)
	}
	w := converter("web", awEvento{Data: map[string]any{"url": grande, "title": "curto"}})
	if n := len([]rune(w.URL)); n != maxURL || w.Titulo != "curto" {
		t.Errorf("url: %d / %q", n, w.Titulo)
	}
}

// novoAWMulti simula o aw-server com vários buckets (id → tipo) e seus eventos.
func novoAWMulti(t *testing.T, buckets map[string]string, eventos map[string][]awEvento) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/0/buckets/" {
			lista := map[string]awBucket{}
			for id, tipo := range buckets {
				lista[id] = awBucket{ID: id, Type: tipo}
			}
			_ = json.NewEncoder(w).Encode(lista)
			return
		}
		for id := range buckets {
			if r.URL.Path == "/api/0/buckets/"+id+"/events" {
				_ = json.NewEncoder(w).Encode(filtrarAW(t, eventos[id], r))
				return
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestLote413NoWebNaoTravaJanela(t *testing.T) {
	base := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)
	web := make([]awEvento, 4)
	for i := range web {
		web[i] = awEvento{Timestamp: base.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano), Data: map[string]any{"url": fmt.Sprintf("https://x.com/%d", i)}}
	}
	web[2].Data["title"] = "GIGANTE" // este evento sempre dá 413
	aw := novoAWMulti(t,
		map[string]string{"aw-watcher-web_PC": "web.tab.current", "aw-watcher-window_PC": "currentwindow"},
		map[string][]awEvento{"aw-watcher-web_PC": web, "aw-watcher-window_PC": evs(3, base)})
	var mu sync.Mutex
	aceitos := map[string]int{}
	av := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var l LoteIngest
		_ = json.NewDecoder(r.Body).Decode(&l)
		for _, e := range l.Eventos {
			if e.Titulo == "GIGANTE" {
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				return
			}
		}
		mu.Lock()
		for _, e := range l.Eventos {
			aceitos[e.Bucket]++
		}
		mu.Unlock()
		w.WriteHeader(200)
	}))
	t.Cleanup(av.Close)
	c := novoColetor(t, aw.URL, av.URL)
	if err := c.ciclo(context.Background()); err != nil {
		t.Fatalf("413 isolado não deveria falhar o ciclo: %v", err)
	}
	if aceitos["web"] != 3 || aceitos["janela"] != 3 {
		t.Errorf("aceitos: %v (esperava 3 web sem o gigante e 3 janela)", aceitos)
	}
	est := c.carregarEstado()
	if got, _ := time.Parse(time.RFC3339Nano, est["aw-watcher-web_PC"]); !got.Equal(base.Add(3 * time.Second)) {
		t.Errorf("estado web deveria passar do evento descartado: %v", est)
	}
}

func TestErroNumBucketNaoImpedeOsOutros(t *testing.T) {
	base := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)
	web := []awEvento{{Timestamp: base.Format(time.RFC3339Nano), Data: map[string]any{"url": "https://x.com"}}}
	aw := novoAWMulti(t,
		map[string]string{"aw-watcher-web_PC": "web.tab.current", "aw-watcher-window_PC": "currentwindow"},
		map[string][]awEvento{"aw-watcher-web_PC": web, "aw-watcher-window_PC": evs(2, base)})
	av := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var l LoteIngest
		_ = json.NewDecoder(r.Body).Decode(&l)
		if len(l.Eventos) > 0 && l.Eventos[0].Bucket == "web" {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(200)
	}))
	t.Cleanup(av.Close)
	c := novoColetor(t, aw.URL, av.URL)
	if err := c.ciclo(context.Background()); err == nil {
		t.Error("esperava o erro do bucket web")
	}
	est := c.carregarEstado()
	if _, ok := est["aw-watcher-web_PC"]; ok {
		t.Errorf("estado do web não deveria avançar: %v", est)
	}
	if got, _ := time.Parse(time.RFC3339Nano, est["aw-watcher-window_PC"]); !got.Equal(base.Add(time.Second)) {
		t.Errorf("janela deveria ter sido enviada: %v", est)
	}
}

func TestSinalDeVida(t *testing.T) {
	aw := novoAW(t, nil)
	av := novoAvoce(t, 200)
	c := novoColetor(t, aw.URL, av.srv.URL)
	if err := c.ciclo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(av.lotes) != 1 || av.lotes[0].Eventos == nil || len(av.lotes[0].Eventos) != 0 {
		t.Fatalf("lotes: %+v", av.lotes)
	}
}
