# Instaladores do coletor de produtividade

Instalação por usuário, sem senha de administrador. Os comandos prontos aparecem no painel
(Produtividade > Dispositivos > "Instalar para…"). Os scripts recebem exatamente
`<URL_DO_AVOCE> <CODIGO>`; o nome do PC é o `hostname`.

## Versões fixadas (conferidas em 2026-11-13)

- ActivityWatch: `v0.14.2` (release latest do GitHub)
  - Mac: `activitywatch-v0.14.2-macos-arm64.dmg` / `activitywatch-v0.14.2-macos-x86_64.dmg`
    (https://github.com/ActivityWatch/activitywatch/releases/download/v0.14.2/…)
  - Windows: `activitywatch-v0.14.2-windows-x86_64.zip` (contém `aw-qt.exe`)
  - Foram usados os pacotes clássicos (não os `activitywatch-tauri-*`).
- Extensão "ActivityWatch Web Watcher": ID `nglaklhklhcoonedhgnpgddginnjdadi`
  (https://chromewebstore.google.com/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi,
  o mesmo link do README oficial do aw-watcher-web). Existe outro item homônimo na loja
  (`fdlchjabjccnihpndlmkfobegggjpnhi`) que NÃO é o oficial.
- Para atualizar o ActivityWatch: troque `AW_VERSAO` / `$AwVersao` nos dois scripts.

## Publicar no servidor

Copie para `COLETOR_DIST_DIR` (padrão `/opt/avoce/coletor-dist`): os 3 binários de
`coletor-produtividade/dist` (`make dist`) e `instalar-mac.sh` e `instalar-windows.ps1`.
A rota `GET /api/produtividade/coletor/:arquivo` serve só esses 5 nomes.

## Reinstalação

Rodar de novo atualiza os binários sem duplicar: o coletor é parado antes de trocar o
binário, o atalho da pasta Inicializar e o item de login são sobrescritos/recriados e o
LaunchAgent é descarregado antes de recarregar.

## Política de força-instalação do Chrome (opcional, NÃO VALIDADA)

Só roda como administrador/root (Windows: `HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist`;
Mac: `defaults write /Library/Preferences/com.google.Chrome ExtensionInstallForcelist`). Sem admin, é pulada.
Atenção: o Chrome costuma ignorar essa política em máquina fora de domínio/sem gerenciamento
(e no Mac exige perfil gerenciado), e rodar o instalador do Mac como root pareia como root.
**Verificar na máquina real (Step 4); se o Chrome ignorar, remover o trecho dos dois scripts.**

## Teste real pendente (Step 4)

Mac e Windows com usuário comum: colar o comando, as telas de Acessibilidade/extensão abrem,
em até 10 min os três ✓ ficam verdes, e após reiniciar volta a enviar sozinho.
Se o pareamento falhar no Windows, o log do coletor fica em `%APPDATA%\avoce-coletor\coletor.log`.
