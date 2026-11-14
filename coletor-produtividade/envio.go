package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	tamanhoLote      = 2000
	sobreposicao     = 15 * time.Minute
	janelaInicial    = 24 * time.Hour
	awURLPadrao      = "http://localhost:5600"
	errTokenRevogado = "token revogado"
)

type eventoLote struct {
	Bucket     string  `json:"bucket"`
	Inicio     string  `json:"inicio"`
	DuracaoSeg float64 `json:"duracaoSeg"`
	App        string  `json:"app,omitempty"`
	Titulo     string  `json:"titulo,omitempty"`
	URL        string  `json:"url,omitempty"`
	Afk        *bool   `json:"afk,omitempty"`
}

type LoteIngest struct {
	Versao  string       `json:"versao"`
	So      string       `json:"so"`
	Eventos []eventoLote `json:"eventos"`
}

type Coletor struct {
	AwURL    string
	AvoceURL string
	Token    string
	Dir      string
	HTTP     *http.Client
	Agora    func() time.Time
	Log      *log.Logger
	So       string
	Versao   string
}

func (c *Coletor) enviar(ctx context.Context, eventos []eventoLote) error {
	if eventos == nil {
		eventos = []eventoLote{}
	}
	corpo, err := json.Marshal(LoteIngest{Versao: c.Versao, So: c.So, Eventos: eventos})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.AvoceURL+"/api/produtividade/ingest", bytes.NewReader(corpo))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode == http.StatusUnauthorized {
		return errors.New(errTokenRevogado)
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("Avoce respondeu %d", resp.StatusCode)
	}
	return nil
}

// ciclo lê os buckets do ActivityWatch e envia os eventos novos ao Avoce.
// Sempre envia ao menos um lote (vazio) como sinal de vida.
func (c *Coletor) ciclo(ctx context.Context) error {
	buckets, err := c.listarBuckets(ctx)
	if err != nil {
		return fmt.Errorf("aw-server inacessível: %w", err)
	}
	estado := c.carregarEstado()
	ids := make([]string, 0, len(buckets))
	for id := range buckets {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	posts := 0
	var primeiroErro error
	for _, id := range ids {
		desde := c.Agora().Add(-janelaInicial)
		if s, ok := estado[id]; ok {
			if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
				desde = t.Add(-sobreposicao)
			}
		}
		evs, err := c.eventosDesde(ctx, id, desde)
		if err != nil {
			c.Log.Printf("erro lendo bucket %s: %v", id, err)
			if primeiroErro == nil {
				primeiroErro = err
			}
			continue
		}
		type par struct {
			t time.Time
			e eventoLote
		}
		ps := make([]par, 0, len(evs))
		for _, ev := range evs {
			t, err := time.Parse(time.RFC3339Nano, ev.Timestamp)
			if err != nil {
				continue
			}
			ps = append(ps, par{t, converter(buckets[id], ev)})
		}
		sort.Slice(ps, func(i, j int) bool { return ps[i].t.Before(ps[j].t) })
		for i := 0; i < len(ps); i += tamanhoLote {
			fim := min(i+tamanhoLote, len(ps))
			lote := make([]eventoLote, 0, fim-i)
			maior := ps[i].t
			for _, p := range ps[i:fim] {
				lote = append(lote, p.e)
				if p.t.After(maior) {
					maior = p.t
				}
			}
			posts++
			if err := c.enviar(ctx, lote); err != nil {
				c.Log.Printf("falha ao enviar %d eventos de %s: %v", len(lote), id, err)
				return err
			}
			if atual, err := time.Parse(time.RFC3339Nano, estado[id]); err != nil || maior.After(atual) {
				estado[id] = maior.UTC().Format(time.RFC3339Nano)
				if err := c.salvarEstado(estado); err != nil {
					c.Log.Printf("erro salvando estado: %v", err)
				}
			}
		}
	}
	if posts == 0 {
		if err := c.enviar(ctx, nil); err != nil {
			c.Log.Printf("falha no sinal de vida: %v", err)
			return err
		}
	}
	return primeiroErro
}

// parear troca o código de pareamento por um token e grava config.json em dir.
func parear(h *http.Client, dir, avoceURL, codigo, nome, so string) error {
	avoceURL = strings.TrimRight(avoceURL, "/")
	corpo, _ := json.Marshal(map[string]string{"codigo": codigo, "nome": nome, "so": so})
	resp, err := h.Post(avoceURL+"/api/produtividade/parear", "application/json", bytes.NewReader(corpo))
	if err != nil {
		return fmt.Errorf("não foi possível conectar ao Avoce: %w", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusBadRequest:
		return errors.New("código de pareamento inválido ou expirado")
	case resp.StatusCode == http.StatusTooManyRequests:
		return errors.New("muitas tentativas; aguarde um minuto e tente de novo")
	case resp.StatusCode/100 != 2:
		return fmt.Errorf("o Avoce respondeu com erro %d", resp.StatusCode)
	}
	var r struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil || r.Token == "" {
		return errors.New("resposta inválida do Avoce")
	}
	return salvarConfig(dir, config{AvoceURL: avoceURL, Token: r.Token, AwURL: awURLPadrao})
}
