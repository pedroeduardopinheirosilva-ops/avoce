package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSinalDeVidaSerializaListaVazia(t *testing.T) {
	b, _ := json.Marshal(LoteIngest{Versao: "1", So: "mac", Eventos: []eventoLote{}})
	if string(b) != `{"versao":"1","so":"mac","eventos":[]}` {
		t.Errorf("json: %s", b)
	}
}

func TestTokenRevogadoNaoApagaConfigNemAvancaEstado(t *testing.T) {
	aw := novoAW(t, evs(2, novoColetor(t, "", "").Agora()))
	av := novoAvoce(t, 401)
	c := novoColetor(t, aw.URL, av.srv.URL)
	if err := c.ciclo(context.Background()); err == nil {
		t.Error("esperava erro em 401")
	}
	if len(c.carregarEstado()) != 0 {
		t.Error("estado não deveria avançar")
	}
}

func TestParear(t *testing.T) {
	var corpo map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/produtividade/parear" {
			http.NotFound(w, r)
			return
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &corpo)
		if corpo["codigo"] != "ABC" {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":"codigo_invalido"}`))
			return
		}
		_, _ = w.Write([]byte(`{"token":"segredo"}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	if err := parear(http.DefaultClient, dir, srv.URL+"/", "ABC", "PC-1", "mac"); err != nil {
		t.Fatal(err)
	}
	if corpo["nome"] != "PC-1" || corpo["so"] != "mac" {
		t.Errorf("corpo: %v", corpo)
	}
	cfg, err := carregarConfig(dir)
	if err != nil || cfg.Token != "segredo" || cfg.AvoceURL != srv.URL || cfg.AwURL != "http://localhost:5600" {
		t.Errorf("config: %+v %v", cfg, err)
	}
	if err := parear(http.DefaultClient, t.TempDir(), srv.URL, "ERRADO", "PC", "mac"); err == nil {
		t.Error("esperava erro de código inválido")
	}
	if _, err := os.Stat(filepath.Join(dir, "config.json")); err != nil {
		t.Error(err)
	}
}
