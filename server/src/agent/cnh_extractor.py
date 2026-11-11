#!/usr/bin/env python3
"""
CNH-e Digital PDF Data Extractor
=================================
Solução multi-estratégia para extrair dados pessoais de CNH digital brasileira.

A CNH-e é um PDF assinado digitalmente que contém os dados pessoais DENTRO DE
IMAGENS JPEG embarcadas, não como texto extraível. O pdftotext/pdfplumber só
captura o cabeçalho/rodapé institucional.

ESTRATÉGIAS DE EXTRAÇÃO (em ordem de confiabilidade):
1. MRZ (Machine Readable Zone) - OCR na zona MRZ da 3ª imagem
2. OCR na imagem principal (img-001) com crop por regiões conhecidas
3. Claude Vision API como fallback inteligente

Autor: Pedro Eduardo Pinheiro Silva
Para uso no sistema AvoceSystem / PSA Docs
"""

import re
import sys
import json
import os
import subprocess
import shutil
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional


# ============================================================
# MODELO DE DADOS
# ============================================================

@dataclass
class CNHData:
    nome: Optional[str] = None
    cpf: Optional[str] = None
    rg: Optional[str] = None
    orgao_emissor_rg: Optional[str] = None
    uf_emissor_rg: Optional[str] = None
    data_nascimento: Optional[str] = None
    local_nascimento: Optional[str] = None
    nacionalidade: Optional[str] = None
    filiacao_pai: Optional[str] = None
    filiacao_mae: Optional[str] = None
    numero_registro: Optional[str] = None
    categoria: Optional[str] = None
    primeira_habilitacao: Optional[str] = None
    data_emissao: Optional[str] = None
    data_validade: Optional[str] = None
    local_emissao: Optional[str] = None

    def to_dict(self):
        return {k: v for k, v in asdict(self).items() if v is not None}

    def completude(self) -> float:
        """Percentual de campos preenchidos"""
        campos = asdict(self)
        preenchidos = sum(1 for v in campos.values() if v)
        return preenchidos / len(campos) * 100


# ============================================================
# ESTRATÉGIA 1: PARSE MRZ (Machine Readable Zone)
# ============================================================

def parse_mrz(mrz_lines: list) -> 'CNHData':
    """
    Parseia as 3 linhas MRZ da CNH brasileira.

    Formato CNH-e MRZ (ICAO 9303 TD1 adaptado):
    Linha 1: I<BRA{nº_doc}<{check}<<<<<<<<<<<<
    Linha 2: {YYMMDD_nasc}{check}{sexo}{YYMMDD_val}{check}{pais}<<<{check}
    Linha 3: {PRIMEIRO_NOME}<<{DEMAIS_NOMES}<

    A MRZ está na 3ª imagem embarcada do PDF (img-003).
    """
    data = CNHData()

    if len(mrz_lines) < 3:
        return data

    line1 = mrz_lines[0].strip().replace(' ', '')
    line2 = mrz_lines[1].strip().replace(' ', '')
    line3 = mrz_lines[2].strip().replace(' ', '')

    # Linha 1: I<BRA{numero}<{check}<<<...
    m1 = re.match(r'I<BRA(\d+)<(\d+)<+', line1)
    if m1:
        data.numero_registro = m1.group(1)

    # Linha 2: {YYMMDD}{check}{M/F}{YYMMDD}{check}{BRA}<<<...{check}
    # Exemplo: 8309282M3305245BRA<<<<<<<<<<<2
    m2 = re.match(r'(\d{6})(\d)([MF])(\d{6})(\d)([A-Z]{3})', line2)
    if m2:
        nasc_raw = m2.group(1)  # 830928
        val_raw = m2.group(4)   # 330524

        # YYMMDD -> DD/MM/YYYY
        yy, mm, dd = nasc_raw[:2], nasc_raw[2:4], nasc_raw[4:6]
        century = '19' if int(yy) > 30 else '20'
        data.data_nascimento = f"{dd}/{mm}/{century}{yy}"

        yy_v, mm_v, dd_v = val_raw[:2], val_raw[2:4], val_raw[4:6]
        century_v = '20' if int(yy_v) < 80 else '19'
        data.data_validade = f"{dd_v}/{mm_v}/{century_v}{yy_v}"

    # Linha 3: Na CNH brasileira o formato é:
    # PRIMEIRO_NOME<<DEMAIS_NOMES_SEPARADOS_POR_<
    if line3:
        name_part = line3.rstrip('<')
        parts = name_part.split('<<')
        if len(parts) >= 2:
            primeiro = parts[0].replace('<', ' ')
            demais = ' '.join(p.replace('<', ' ') for p in parts[1:])
            data.nome = f"{primeiro} {demais}".strip()
        elif len(parts) == 1:
            data.nome = parts[0].replace('<', ' ').strip()

    data.nacionalidade = "BRASILEIRO(A)"

    return data


def extract_mrz_from_image(image_path: str) -> list:
    """
    Extrai linhas MRZ de uma imagem usando Tesseract OCR.
    A MRZ usa fonte OCR-B monoespaçada — Tesseract funciona bem nela.
    """
    try:
        result = subprocess.run(
            ['tesseract', image_path, 'stdout', '--psm', '6'],
            capture_output=True, text=True, timeout=30
        )

        text = result.stdout
        lines = [l.strip() for l in text.split('\n') if l.strip()]

        # Filtro grosso: contém '<' e tem comprimento de MRZ
        candidatas = [l for l in lines if '<' in l and len(l) > 20]

        # Filtro fino — SEM ele qualquer ruído de OCR com '<' virava "MRZ" e o
        # parser gerava nome-lixo (ex.: 'Ss)=|\\S=|$22XSSooMS |' saiu de uma
        # conta de luz). A MRZ da CNH usa só A-Z, 0-9 e '<'; a primeira linha
        # começa com I<BRA. Exige as duas coisas antes de aceitar.
        limpas = []
        for l in candidatas:
            compacta = l.replace(' ', '').upper()
            validos = sum(1 for ch in compacta if ch.isalnum() or ch == '<')
            if validos / max(1, len(compacta)) >= 0.95:
                limpas.append(compacta)

        if not any(l.startswith('I<BRA') or l.startswith('L<BRA') for l in limpas):
            return []

        return limpas
    except Exception as e:
        print(f"  [WARN] Tesseract MRZ failed: {e}", file=sys.stderr)
        return []


# ============================================================
# ESTRATÉGIA 2: OCR FULL-PAGE + REGEX PARSING (img-001)
# ============================================================

def ocr_full_page(image_path: str) -> str:
    """
    Executa OCR full-page na imagem principal da CNH via Tesseract.
    Usa --psm 3 (automatic page segmentation) que funciona bem
    com o layout tabular da CNH.
    """
    try:
        result = subprocess.run(
            ['tesseract', image_path, 'stdout', '--psm', '3', '-l', 'por+eng'],
            capture_output=True, text=True, timeout=30
        )
        return result.stdout
    except Exception as e:
        # Fallback sem -l se não tiver o pacote de idioma
        try:
            result = subprocess.run(
                ['tesseract', image_path, 'stdout', '--psm', '3'],
                capture_output=True, text=True, timeout=30
            )
            return result.stdout
        except Exception as e2:
            print(f"  [WARN] Tesseract full-page failed: {e2}", file=sys.stderr)
            return ""


def parse_ocr_text(text: str) -> 'CNHData':
    """
    Parseia o texto OCR full-page da CNH usando regex.
    """
    data = CNHData()

    # Limpar artefatos comuns do OCR
    clean = text.replace('|', '').replace('[', '').replace(']', '')
    clean = clean.replace('(', '').replace(')', '')
    lines = [l.strip() for l in clean.split('\n') if l.strip()]

    full_text = ' '.join(lines)

    # --- CPF ---
    cpf_match = re.search(r'(\d{3}[.\s]\d{3}[.\s]\d{3}[-.\s]\d{2})', full_text)
    if cpf_match:
        cpf_raw = cpf_match.group(1)
        digits = re.sub(r'[^\d]', '', cpf_raw)
        if len(digits) == 11 and validar_cpf(digits):
            data.cpf = f"{digits[:3]}.{digits[3:6]}.{digits[6:9]}-{digits[9:11]}"

    # --- RG + ÓRGÃO EMISSOR ---
    # Padrão: "953084582 SSP BA"
    rg_match = re.search(
        r'(\d{7,12})\s+(SSP|SDS|SESP|PC|IFP|DETRAN|SPTC|POLITEC|IGP)\s+([A-Z]{2})',
        full_text
    )
    if rg_match:
        data.rg = rg_match.group(1)
        data.orgao_emissor_rg = rg_match.group(2)
        data.uf_emissor_rg = rg_match.group(3)

    # --- DATAS (DD/MM/YYYY) ---
    # Data de nascimento vem perto de cidade de nascimento
    nasc_match = re.search(r'(\d{2}/\d{2}/\d{4})\s*,?\s*([A-Z][A-Z\s]+,\s*[A-Z]{2})', full_text)
    if nasc_match:
        data.data_nascimento = nasc_match.group(1)
        data.local_nascimento = nasc_match.group(2).strip()

    # Primeira habilitação
    hab_match = re.search(r'HABILITA\S*\s+(\d{2}/\d{2}/\d{4})', full_text, re.IGNORECASE)
    if hab_match:
        data.primeira_habilitacao = hab_match.group(1)

    # Emissão e validade
    emissao_match = re.search(r'EMISS.*?(\d{2}/\d{2}/\d{4})', full_text, re.IGNORECASE)
    if emissao_match:
        data.data_emissao = emissao_match.group(1)

    validade_match = re.search(r'VALID.*?(\d{2}/\d{2}/\d{4})', full_text, re.IGNORECASE)
    if validade_match:
        data.data_validade = validade_match.group(1)

    # --- Nº REGISTRO ---
    reg_match = re.search(r'REGISTRO.*?(\d{10,11})', full_text, re.IGNORECASE)
    if reg_match:
        data.numero_registro = reg_match.group(1)

    # --- NACIONALIDADE ---
    # A CNH sempre imprime "BRASILEIRA" (concorda com o substantivo feminino "nacionalidade",
    # não com o sexo do titular) — o regex antigo só aceitava a forma masculina e nunca batia.
    nac_match = re.search(r'BRASILEIR[OA]\w*', full_text, re.IGNORECASE)
    if nac_match:
        data.nacionalidade = nac_match.group(0).upper()

    # --- FILIAÇÃO ---
    filiacao_section = re.search(
        r'FILIA[CÇG]?[AÃ]O\s*\n?\s*(.+?)(?:\n|$)\s*\n?\s*(.+?)(?:\n|$)',
        clean, re.IGNORECASE | re.MULTILINE
    )
    if filiacao_section:
        pai = filiacao_section.group(1).strip()
        mae = filiacao_section.group(2).strip()
        pai = re.sub(r'^FILIA\S*\s*', '', pai, flags=re.IGNORECASE).strip()
        mae = re.sub(r'^FILIA\S*\s*', '', mae, flags=re.IGNORECASE).strip()
        pai = re.sub(r'^[^A-ZÀ-Ü]+', '', pai, flags=re.IGNORECASE).strip()
        mae = re.sub(r'^[^A-ZÀ-Ü]+', '', mae, flags=re.IGNORECASE).strip()
        mae = re.sub(r'^[a-z\s/\\]+', '', mae).strip()
        pai = re.sub(r'^[a-z\s/\\]+', '', pai).strip()
        pai = re.sub(r'[^A-ZÀ-Ü\s]', '', pai, flags=re.IGNORECASE).strip()
        mae = re.sub(r'[^A-ZÀ-Ü\s]', '', mae, flags=re.IGNORECASE).strip()
        pai = re.sub(r'\s+', ' ', pai).strip()
        mae = re.sub(r'\s+', ' ', mae).strip()
        pai = re.sub(r'DA(\s?)SILVA', 'DA SILVA', pai)
        mae = re.sub(r'DA(\s?)SILVA', 'DA SILVA', mae)
        if len(pai) > 3:
            data.filiacao_pai = pai
        if len(mae) > 3:
            data.filiacao_mae = mae

    # --- CATEGORIA ---
    cat_match = re.search(r'CAT\s*HAB\s*\n?\s*([A-E]{1,2})', full_text, re.IGNORECASE)
    if cat_match:
        data.categoria = cat_match.group(1).upper()

    return data


def _variantes_imagem(image_path: str, work_dir: str) -> list:
    """Gera versões pré-processadas da foto para o tesseract.

    Foto de celular de CNH plastificada (brilho, baixo contraste, resolução de
    tela) sai ilegível no tesseract cru — na medição, a foto rendeu um único
    número e o nome corrompido. Escala de cinza + autocontraste + upscale é o
    que normalmente separa lixo de texto utilizável.
    """
    saidas = [image_path]
    try:
        from PIL import Image, ImageOps, ImageFilter
    except Exception:
        return saidas

    try:
        base = Image.open(image_path)
        if base.mode != 'L':
            base = base.convert('L')

        cinza = ImageOps.autocontrast(base)
        p1 = str(Path(work_dir) / 'v_cinza.png')
        cinza.save(p1)
        saidas.append(p1)

        # Upscale 2x com filtro: dígito pequeno de CPF só aparece com mais pixels.
        w, h = cinza.size
        grande = cinza.resize((w * 2, h * 2), Image.LANCZOS).filter(ImageFilter.SHARPEN)
        p2 = str(Path(work_dir) / 'v_2x.png')
        grande.save(p2)
        saidas.append(p2)

        # Binarização simples sobre o upscale — ajuda em papel amarelado.
        limiar = 140
        p3 = str(Path(work_dir) / 'v_bin.png')
        binaria = grande.point(lambda v: 255 if v > limiar else 0, mode='1')
        binaria.save(p3)
        saidas.append(p3)

        # A CNH é paisagem; foto de celular costuma vir em retrato. Girada, o
        # tesseract perde a adjacência rótulo→valor e as regex ficam cegas mesmo
        # com o texto legível na imagem. Só gera as rotações quando a foto está
        # em retrato, para não dobrar o trabalho à toa.
        if h > w:
            for graus in (270, 90):
                pr = str(Path(work_dir) / f'v_rot{graus}.png')
                binaria.rotate(graus, expand=True).save(pr)
                saidas.append(pr)
    except Exception as e:
        print(f"  [WARN] pré-processamento falhou: {e}", file=sys.stderr)

    return saidas


def _tesseract(image_path: str, psm: str) -> str:
    for args in (['-l', 'por+eng'], []):
        try:
            r = subprocess.run(
                ['tesseract', image_path, 'stdout', '--psm', psm] + args,
                capture_output=True, text=True, timeout=30,
                env={**os.environ, 'OMP_THREAD_LIMIT': '1'},
            )
            if r.stdout.strip():
                return r.stdout
        except Exception:
            continue
    return ''


def _tem_cpf_valido(texto: str) -> bool:
    for c in re.findall(r'\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}|\d{11}', texto):
        if validar_cpf(c):
            return True
    return False


def extract_via_fullpage_ocr(main_image_path: str, corpus_out: list = None) -> 'CNHData':
    """OCR determinístico com várias tentativas.

    Percorre combinações de pré-processamento × modo de segmentação e para na
    primeira cujo texto contenha um CPF que passa no dígito verificador — esse
    é um critério de aceitação exato, sem chute: um OCR errado praticamente
    nunca produz 11 dígitos que fecham a conta. Não achando CPF em nenhuma,
    fica com o texto mais longo, que é o mais provável de ter os demais campos.
    """
    import tempfile, time
    work_dir = tempfile.mkdtemp(prefix='cnh_prep_')
    # Orçamento de tempo: o documento chega no meio de uma conversa e o lead fica
    # esperando a resposta. Varrer todas as variantes leva ~30s; o CPF costuma sair
    # nas primeiras. Passado o limite, devolve o que já achou.
    limite = time.monotonic() + 12.0
    try:
        com_cpf, sem_cpf = [], []
        melhor = ''
        estourou = False
        for img in _variantes_imagem(main_image_path, work_dir):
            if estourou:
                break
            for psm in ('3', '6'):
                if time.monotonic() > limite and (com_cpf or sem_cpf):
                    print("    OCR: orçamento de tempo esgotado", file=sys.stderr)
                    estourou = True
                    break
                texto = _tesseract(img, psm)
                if not texto.strip():
                    continue
                if len(texto) > len(melhor):
                    melhor = texto
                if corpus_out is not None:
                    corpus_out.append(texto)
                dados = parse_ocr_text(texto)
                if _tem_cpf_valido(texto):
                    print(f"    OCR: CPF válido em {Path(img).name} psm={psm}", file=sys.stderr)
                    com_cpf.append(dados)
                    # CPF válido + qualquer outro campo de identidade já basta:
                    # o resto vem da MRZ ou de outra variante. Sem esta saída
                    # antecipada o PDF, que resolve na primeira tentativa, pagava
                    # todas as variantes à toa.
                    if dados.nome or dados.rg or dados.data_nascimento:
                        return merge_results(*com_cpf, *sem_cpf)
                elif any(getattr(dados, f) for f in ('nome', 'rg', 'data_nascimento')):
                    sem_cpf.append(dados)

        if com_cpf or sem_cpf:
            # CPF válido tem prioridade; o resto completa os campos que faltarem.
            return merge_results(*com_cpf, *sem_cpf)
        if not melhor.strip():
            return CNHData()
        print(f"    OCR: nenhum campo reconhecido; usando o texto mais longo", file=sys.stderr)
        return parse_ocr_text(melhor)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


# ============================================================
# VALIDAÇÃO CPF
# ============================================================

def validar_cpf(cpf: str) -> bool:
    d = re.sub(r'\D', '', cpf)
    if len(d) != 11:
        return False
    if len(set(d)) == 1:
        return False

    def calc(n):
        s = sum(int(d[i]) * (n + 1 - i) for i in range(n))
        r = (s * 10) % 11
        return 0 if r >= 10 else r

    return calc(9) == int(d[9]) and calc(10) == int(d[10])


# ============================================================
# ESTRATÉGIA 3: CLAUDE VISION API (mais confiável, com custo)
# ============================================================

def extract_via_claude_vision(image_path: str, api_key: str) -> 'CNHData':
    """
    Usa Claude Vision API para extrair dados da imagem da CNH.
    Mais confiável que OCR local, mas tem custo por chamada.
    """
    import base64
    import httpx

    with open(image_path, 'rb') as f:
        img_b64 = base64.b64encode(f.read()).decode()

    prompt = """Extraia os seguintes campos desta CNH brasileira e retorne APENAS um JSON válido:
{
  "nome": "nome completo",
  "cpf": "XXX.XXX.XXX-XX",
  "rg": "número do RG",
  "orgao_emissor_rg": "órgão emissor (ex: SSP)",
  "uf_emissor_rg": "UF do emissor (ex: BA)",
  "data_nascimento": "DD/MM/AAAA",
  "local_nascimento": "cidade, UF",
  "nacionalidade": "...",
  "filiacao_pai": "nome do pai",
  "filiacao_mae": "nome da mãe",
  "numero_registro": "nº registro CNH",
  "categoria": "categoria habilitação",
  "primeira_habilitacao": "DD/MM/AAAA",
  "data_emissao": "DD/MM/AAAA",
  "data_validade": "DD/MM/AAAA"
}
Retorne APENAS o JSON, sem markdown, sem explicação."""

    response = httpx.post(
        'https://api.anthropic.com/v1/messages',
        headers={
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        json={
            'model': 'claude-haiku-4-5-20251001',
            'max_tokens': 1024,
            'messages': [{
                'role': 'user',
                'content': [
                    {
                        'type': 'image',
                        'source': {
                            'type': 'base64',
                            'media_type': 'image/png',
                            'data': img_b64,
                        }
                    },
                    {
                        'type': 'text',
                        'text': prompt,
                    }
                ]
            }]
        },
        timeout=60
    )

    result = response.json()
    text = result['content'][0]['text']

    # Limpar possível markdown
    text = text.strip()
    if text.startswith('```'):
        text = re.sub(r'^```\w*\n?', '', text)
        text = re.sub(r'\n?```$', '', text)

    parsed = json.loads(text)
    valid_fields = set(asdict(CNHData()).keys())
    return CNHData(**{k: v for k, v in parsed.items() if k in valid_fields and v})


# ============================================================
# PIPELINE PRINCIPAL
# ============================================================

IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'}


def eh_pdf(caminho: str) -> bool:
    """PDF pela assinatura do arquivo, nao pela extensao — o WhatsApp entrega
    nome generico ('doc.bin') e o mimetype nem sempre vem."""
    try:
        with open(caminho, 'rb') as f:
            return f.read(5) == b'%PDF-'
    except Exception:
        return Path(caminho).suffix.lower() == '.pdf'


def extract_images_from_pdf(pdf_path: str, output_dir: str) -> list:
    """Extrai imagens embarcadas do PDF usando pdfimages."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ['pdfimages', '-png', pdf_path, f'{output_dir}/img'],
        check=True, capture_output=True
    )

    images = sorted(Path(output_dir).glob('img-*.png'))
    return [str(p) for p in images]


def preparar_imagens(caminho: str, output_dir: str) -> list:
    """Devolve a lista de imagens a analisar.

    CNH digital (PDF do SENATRAN): a camada de texto so tem o aviso do Assinador
    Serpro — os dados estao em JPEGs embarcados, entao extrai com pdfimages.
    CNH fisica (foto): o proprio arquivo ja e a imagem.
    """
    if eh_pdf(caminho):
        return extract_images_from_pdf(caminho, output_dir)

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    destino = str(Path(output_dir) / ('foto' + (Path(caminho).suffix.lower() or '.jpg')))
    shutil.copyfile(caminho, destino)
    return [destino]


def merge_results(*results: 'CNHData') -> 'CNHData':
    """
    Mescla resultados de múltiplas estratégias.
    Prioriza o primeiro resultado não-nulo para cada campo.
    """
    merged = CNHData()
    fields = list(asdict(merged).keys())

    for field in fields:
        for result in results:
            value = getattr(result, field)
            if value and str(value).strip():
                setattr(merged, field, value)
                break

    return merged


def extract_cnh_data(caminho: str, claude_api_key: str = None, usar_ia: bool = True) -> 'CNHData':
    """
    Pipeline principal de extração. Aceita CNH digital (PDF do SENATRAN) OU
    foto da CNH física — em ambos os casos as duas primeiras estratégias são
    100% locais (tesseract + regex), sem chamada a nenhuma IA.

    Tenta na ordem:
    1. MRZ parse (determinístico: nome, nascimento, nº registro, validade)
    2. OCR full-page + regex (determinístico: CPF, RG, órgão emissor, filiação)
    3. Claude Vision — só quando `usar_ia` e há chave; é a única etapa paga.

    Retorna resultado mesclado das estratégias.
    """
    import tempfile

    output_dir = tempfile.mkdtemp(prefix='cnh_extract_')

    try:
        print(f"[CNH Extractor] Processando: {caminho}", file=sys.stderr)

        images = preparar_imagens(caminho, output_dir)
        print(f"  Imagens para analisar: {len(images)}", file=sys.stderr)

        if not images:
            raise ValueError("Nenhuma imagem para analisar")

        # A CNH-e embarca 3 imagens 963x680 (frente / categorias / legenda+MRZ);
        # a foto da CNH física é uma imagem só. Trata os dois casos: fica com as
        # grandes quando existirem, senão com a maior que houver.
        from PIL import Image

        candidatas = []
        for img_path in images:
            try:
                w, h = Image.open(img_path).size
            except Exception:
                continue
            file_size = Path(img_path).stat().st_size
            print(f"  {Path(img_path).name}: {w}x{h}, {file_size:,} bytes", file=sys.stderr)
            candidatas.append((img_path, file_size, w, h))

        if not candidatas:
            raise ValueError("Nenhuma imagem legível")

        large_images = [(p, sz) for (p, sz, w, h) in candidatas if w >= 900 and h >= 600]
        if not large_images:
            # Foto de celular ou digitalização menor — usa a maior disponível.
            candidatas.sort(key=lambda x: x[1], reverse=True)
            large_images = [(candidatas[0][0], candidatas[0][1])]

        main_img = None
        mrz_img = None

        # A maior é a frente da CNH (dados pessoais)
        large_images.sort(key=lambda x: x[1], reverse=True)
        main_img = large_images[0][0]

        # MRZ: nas outras imagens grandes (CNH-e) ou na própria foto, quando é só uma
        alvos_mrz = [p for p, _ in large_images if p != main_img] or [main_img]
        for img_path in alvos_mrz:
            test_lines = extract_mrz_from_image(img_path)
            if test_lines:
                mrz_img = img_path
                break

        results = []

        # --- Estratégia 1: MRZ ---
        if mrz_img:
            print(f"\n  [Estratégia 1] MRZ detectada em {Path(mrz_img).name}", file=sys.stderr)
            mrz_lines = extract_mrz_from_image(mrz_img)
            if mrz_lines:
                print(f"    MRZ linhas: {mrz_lines}", file=sys.stderr)
                mrz_data = parse_mrz(mrz_lines)
                print(f"    Resultado MRZ: {mrz_data.to_dict()}", file=sys.stderr)
                results.append(mrz_data)
            else:
                print("    MRZ parse falhou", file=sys.stderr)
                results.append(CNHData())
        else:
            print("\n  [Estratégia 1] MRZ não encontrada em nenhuma imagem", file=sys.stderr)
            results.append(CNHData())

        # --- Estratégia 2: OCR por regiões ---
        corpus = []
        if main_img:
            print("\n  [Estratégia 2] OCR full-page + regex na imagem principal...", file=sys.stderr)
            ocr_data = extract_via_fullpage_ocr(main_img, corpus)
            print(f"    Resultado OCR: {ocr_data.to_dict()}", file=sys.stderr)
            results.append(ocr_data)

        # --- Portão de evidência ---------------------------------------------
        # Este extrator é de CNH. Sem esta checagem ele declarava CNH qualquer
        # documento em que achasse um CPF válido — e conta de luz, holerite e
        # CTPS têm CPF. Uma conta de luz virou "CNH" e sobrescreveu o nome do
        # deal com lixo. Só segue se houver marca de CNH: MRZ válida ou termo
        # do documento no texto lido.
        texto_todo = ' '.join(corpus).upper()
        marcas = ('HABILITA', 'CARTEIRA NACIONAL', 'DETRAN', 'PERMISSAO PARA DIRIGIR',
                  'PERMISSÃO PARA DIRIGIR', 'CONDUTOR', 'CAT. HAB', 'CATEGORIA')
        tem_marca = any(m in texto_todo for m in marcas)
        if not mrz_img and not tem_marca:
            print("  [Portão] Sem marca de CNH (MRZ ou termo do documento) — não é CNH", file=sys.stderr)
            return CNHData()

        # --- Estratégia 3: Claude Vision ---
        if usar_ia and claude_api_key and main_img:
            print("\n  [Estratégia 3] Claude Vision API...", file=sys.stderr)
            try:
                vision_data = extract_via_claude_vision(main_img, claude_api_key)
                print(f"    Resultado Vision: {vision_data.to_dict()}", file=sys.stderr)
                results.append(vision_data)
            except Exception as e:
                print(f"    Claude Vision falhou: {e}", file=sys.stderr)

        # Mesclar resultados (prioridade: Vision > OCR > MRZ se Vision disponível)
        if usar_ia and claude_api_key:
            results.reverse()  # Vision primeiro se disponível
        final = merge_results(*results)

        print(f"\n  [RESULTADO FINAL] Completude: {final.completude():.0f}%", file=sys.stderr)
        print(f"  {json.dumps(final.to_dict(), indent=2, ensure_ascii=False)}", file=sys.stderr)

        return final

    finally:
        shutil.rmtree(output_dir, ignore_errors=True)


# ============================================================
# CLI
# ============================================================

if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='Extrai dados de CNH (PDF digital ou foto da física)')
    parser.add_argument('arquivo', help='Caminho do PDF da CNH-e ou da foto da CNH')
    parser.add_argument('--api-key', help='Anthropic API key (para Claude Vision)')
    parser.add_argument('--no-ai', action='store_true',
                        help='Só estratégias locais (MRZ + tesseract), sem chamar IA')
    parser.add_argument('--json', action='store_true', dest='json_output',
                        help='Output apenas JSON no stdout (logs vão para stderr)')

    args = parser.parse_args()

    result = extract_cnh_data(args.arquivo, args.api_key, usar_ia=not args.no_ai)

    if args.json_output:
        print(json.dumps(result.to_dict(), ensure_ascii=False))
    else:
        print("\n" + "=" * 60)
        print("DADOS EXTRAÍDOS DA CNH")
        print("=" * 60)
        for k, v in result.to_dict().items():
            print(f"  {k:25s}: {v}")
