package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

const limiteLog = 5 * 1024 * 1024

type config struct {
	AvoceURL string `json:"avoceUrl"`
	Token    string `json:"token"`
	AwURL    string `json:"awUrl"`
}

func diretorioConfig() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "avoce-coletor"), nil
}

func salvarConfig(dir string, cfg config) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(filepath.Join(dir, "config.json"), b, 0o600)
}

func carregarConfig(dir string) (config, error) {
	var cfg config
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}
	if cfg.AwURL == "" {
		cfg.AwURL = awURLPadrao
	}
	return cfg, nil
}

func (c *Coletor) carregarEstado() map[string]string {
	est := map[string]string{}
	if b, err := os.ReadFile(filepath.Join(c.Dir, "estado.json")); err == nil {
		_ = json.Unmarshal(b, &est)
	}
	return est
}

func (c *Coletor) salvarEstado(est map[string]string) error {
	b, _ := json.Marshal(est)
	tmp := filepath.Join(c.Dir, "estado.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(c.Dir, "estado.json"))
}

// abrirLog abre coletor.log em dir, truncando-o se passou de 5 MB.
func abrirLog(dir string) (*log.Logger, *os.File, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, nil, err
	}
	caminho := filepath.Join(dir, "coletor.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if st, err := os.Stat(caminho); err == nil && st.Size() > limiteLog {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	f, err := os.OpenFile(caminho, flags, 0o600)
	if err != nil {
		return nil, nil, fmt.Errorf("abrindo log: %w", err)
	}
	return log.New(f, "", log.LstdFlags), f, nil
}
