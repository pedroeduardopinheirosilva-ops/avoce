# Instalador por usuário (sem administrador) do ActivityWatch + coletor Avoce para Windows.
# Uso: powershell -ExecutionPolicy Bypass -File instalar-windows.ps1 <AVOCE_URL> <CODIGO>
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$AvoceUrl,
  [Parameter(Mandatory = $true, Position = 1)][string]$Codigo
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AvoceUrl = $AvoceUrl.TrimEnd('/')
$AwVersao = 'v0.14.2'
$AwZipUrl = "https://github.com/ActivityWatch/activitywatch/releases/download/$AwVersao/activitywatch-$AwVersao-windows-x86_64.zip"
$ExtId = 'nglaklhklhcoonedhgnpgddginnjdadi'   # ActivityWatch Web Watcher
$ExtUrl = "https://chromewebstore.google.com/detail/activitywatch-web-watcher/$ExtId"
$NomePc = $env:COMPUTERNAME

$DirAw = Join-Path $env:LOCALAPPDATA 'activitywatch'
$DirColetor = Join-Path $env:LOCALAPPDATA 'avoce-coletor'
$Inicializar = [Environment]::GetFolderPath('Startup')
$LogColetor = Join-Path $env:APPDATA 'avoce-coletor\coletor.log'

function Novo-Atalho($caminho, $alvo, $argumentos, $pasta) {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($caminho)   # mesmo caminho = sobrescreve, sem duplicar
  $lnk.TargetPath = $alvo
  $lnk.Arguments = $argumentos
  $lnk.WorkingDirectory = $pasta
  $lnk.Save()
}

function Parar-Processos($nomes) {
  foreach ($n in $nomes) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

$Tmp = Join-Path $env:TEMP ("avoce-inst-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
  Write-Host "==> Instalando o ActivityWatch $AwVersao..."
  $zip = Join-Path $Tmp 'aw.zip'
  Invoke-WebRequest -Uri $AwZipUrl -OutFile $zip -UseBasicParsing
  $extraido = Join-Path $Tmp 'aw'
  Expand-Archive -Path $zip -DestinationPath $extraido -Force
  $awQtOrigem = Get-ChildItem -Path $extraido -Recurse -Filter 'aw-qt.exe' | Select-Object -First 1
  if (-not $awQtOrigem) { throw 'aw-qt.exe não encontrado no pacote do ActivityWatch.' }

  Parar-Processos @('aw-qt', 'aw-server', 'aw-watcher-afk', 'aw-watcher-window')
  if (Test-Path $DirAw) { Remove-Item -Recurse -Force $DirAw }
  New-Item -ItemType Directory -Path $DirAw | Out-Null
  Copy-Item -Path (Join-Path $awQtOrigem.DirectoryName '*') -Destination $DirAw -Recurse -Force
  $awQt = Join-Path $DirAw 'aw-qt.exe'
  Novo-Atalho (Join-Path $Inicializar 'ActivityWatch.lnk') $awQt '' $DirAw
  Start-Process -FilePath $awQt -WorkingDirectory $DirAw

  Write-Host "==> Instalando o coletor Avoce..."
  New-Item -ItemType Directory -Path $DirColetor -Force | Out-Null
  Parar-Processos @('coletor-windows')
  $exe = Join-Path $DirColetor 'coletor-windows.exe'
  $novo = "$exe.novo"
  Invoke-WebRequest -Uri "$AvoceUrl/api/produtividade/coletor/coletor-windows.exe" -OutFile $novo -UseBasicParsing
  Move-Item -Path $novo -Destination $exe -Force

  # O coletor é um app sem console (windowsgui): confere só o código de saída.
  $p = Start-Process -FilePath $exe -ArgumentList @('parear', '--url', $AvoceUrl, '--codigo', $Codigo, '--nome', $NomePc) `
        -Wait -PassThru -WindowStyle Hidden
  if ($p.ExitCode -ne 0) {
    Write-Host ''
    Write-Host 'Não foi possível parear este computador. O código pode ter expirado ou já ter sido usado.' -ForegroundColor Red
    Write-Host 'Gere um novo código no painel do Avoce (Produtividade > Dispositivos) e rode o comando de novo.' -ForegroundColor Red
    Write-Host "Detalhes, se houver, em: $LogColetor"
    exit 1
  }

  Novo-Atalho (Join-Path $Inicializar 'Avoce Coletor.lnk') $exe 'run' $DirColetor
  Start-Process -FilePath $exe -ArgumentList 'run' -WorkingDirectory $DirColetor -WindowStyle Hidden

  # Opcional: só como administrador, força a extensão por política do Chrome.
  # Sem administrador, pula em silêncio. Ver LEIA-ME.md (precisa ser validado em máquina real).
  $ehAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($ehAdmin) {
    try {
      $chave = 'HKLM:\Software\Policies\Google\Chrome\ExtensionInstallForcelist'
      if (-not (Test-Path $chave)) { New-Item -Path $chave -Force | Out-Null }
      $valor = "$ExtId;https://clients2.google.com/service/update2/crx"
      $props = (Get-ItemProperty -Path $chave).PSObject.Properties | Where-Object { $_.Name -match '^\d+$' }
      if (-not ($props | Where-Object { $_.Value -eq $valor })) {
        $prox = 1 + (($props | ForEach-Object { [int]$_.Name } | Measure-Object -Maximum).Maximum)
        New-ItemProperty -Path $chave -Name ([string]$prox) -Value $valor -PropertyType String -Force | Out-Null
      }
    } catch { }
  }

  Write-Host ''
  Write-Host '==> Instalação concluída. Vai abrir a página da extensão do navegador:'
  Write-Host "  Clique em 'Usar no Chrome' / 'Adicionar ao Chrome' e confirme em 'Adicionar extensão'."
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList $ExtUrl
  } else {
    $edge = @(
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($edge) { Start-Process -FilePath $edge -ArgumentList $ExtUrl } else { Start-Process $ExtUrl }
  }
  Write-Host 'Pronto. Em até 10 minutos o painel do Avoce mostra este computador coletando.'
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
