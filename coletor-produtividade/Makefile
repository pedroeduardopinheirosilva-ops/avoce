VERSAO ?= dev
LDFLAGS = -s -w -X main.versao=$(VERSAO)

.PHONY: test dist clean

test:
	go test ./...

dist:
	mkdir -p dist
	GOOS=windows GOARCH=amd64 go build -ldflags "-H=windowsgui $(LDFLAGS)" -o dist/coletor-windows.exe
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o dist/coletor-mac-arm64
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o dist/coletor-mac-amd64

clean:
	rm -rf dist
