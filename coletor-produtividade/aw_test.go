package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strconv"
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
			lim, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			out := eventos
			if lim > 0 && len(out) > lim {
				out = out[:lim]
			}
			_ = json.NewEncoder(w).Encode(out)
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
	aw := novoAW(t, evs(4500, time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)))
	av := novoAvoce(t, 200)
	c := novoColetor(t, aw.URL, av.srv.URL)
	if err := c.ciclo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(av.lotes) != 3 {
		t.Fatalf("esperava 3 POSTs, veio %d", len(av.lotes))
	}
	for i, n := range []int{2000, 2000, 500} {
		if len(av.lotes[i].Eventos) != n {
			t.Errorf("lote %d: %d", i, len(av.lotes[i].Eventos))
		}
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
