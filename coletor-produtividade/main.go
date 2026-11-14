package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"time"
)

var versao = "dev"

const intervaloCiclo = 5 * time.Minute

func nomeSO() string {
	switch runtime.GOOS {
	case "windows":
		return "windows"
	case "darwin":
		return "mac"
	}
	return runtime.GOOS
}

func falhar(msg string, a ...any) {
	fmt.Fprintf(os.Stderr, msg+"\n", a...)
	os.Exit(1)
}

// registrarNoLog anexa a mensagem ao coletor.log (o mesmo do `run`). No Windows o exe
// é -H=windowsgui e o stderr se perde; o instalador aponta para esse arquivo.
func registrarNoLog(dir, msg string, a ...any) {
	lg, f, err := abrirLog(dir)
	if err != nil {
		return
	}
	defer f.Close()
	lg.Printf(msg, a...)
}

func main() {
	if len(os.Args) < 2 {
		falhar("uso: coletor parear|run|versao")
	}
	switch os.Args[1] {
	case "versao":
		fmt.Println(versao)
	case "parear":
		fs := flag.NewFlagSet("parear", flag.ExitOnError)
		url := fs.String("url", "", "endereço do Avoce")
		codigo := fs.String("codigo", "", "código de pareamento")
		nome := fs.String("nome", "", "nome deste computador")
		_ = fs.Parse(os.Args[2:])
		if *url == "" || *codigo == "" || *nome == "" {
			falhar("informe --url, --codigo e --nome")
		}
		dir, err := diretorioConfig()
		if err != nil {
			falhar("não foi possível localizar a pasta de configuração: %v", err)
		}
		h := &http.Client{Timeout: 30 * time.Second}
		if err := parear(h, dir, *url, *codigo, *nome, nomeSO()); err != nil {
			registrarNoLog(dir, "erro no pareamento: %v", err)
			falhar("erro no pareamento: %v", err)
		}
		fmt.Println("Computador pareado com sucesso.")
	case "run":
		rodar()
	default:
		falhar("comando desconhecido: %s (use parear, run ou versao)", os.Args[1])
	}
}

func rodar() {
	dir, err := diretorioConfig()
	if err != nil {
		falhar("não foi possível localizar a pasta de configuração: %v", err)
	}
	lg, f, err := abrirLog(dir)
	if err != nil {
		falhar("%v", err)
	}
	defer f.Close()
	cfg, err := carregarConfig(dir)
	if err != nil {
		lg.Printf("configuração ausente; execute 'coletor parear' primeiro: %v", err)
		falhar("configuração ausente; execute 'coletor parear' primeiro")
	}
	c := &Coletor{
		AwURL: cfg.AwURL, AvoceURL: cfg.AvoceURL, Token: cfg.Token, Dir: dir,
		HTTP: &http.Client{Timeout: 60 * time.Second}, Agora: time.Now, Log: lg,
		So: nomeSO(), Versao: versao,
	}
	lg.Printf("coletor %s iniciado", versao)
	for {
		if err := c.ciclo(context.Background()); err != nil {
			if err.Error() == errTokenRevogado {
				lg.Printf("token revogado; o dispositivo precisa ser pareado de novo")
			} else {
				lg.Printf("ciclo falhou: %v", err)
			}
		}
		time.Sleep(intervaloCiclo)
	}
}
