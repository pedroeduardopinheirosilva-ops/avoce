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
import subprocess
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

        # Filtrar apenas linhas que parecem MRZ (contêm < e têm ~30 chars)
        mrz_lines = [l for l in lines if '<' in l and len(l) > 20]

        return mrz_lines
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
    nac_match = re.search(r'BRASILEIRO\w*', full_text, re.IGNORECASE)
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


def extract_via_fullpage_ocr(main_image_path: str) -> 'CNHData':
    text = ocr_full_page(main_image_path)
    if not text.strip():
        return CNHData()
    return parse_ocr_text(text)


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

def extract_images_from_pdf(pdf_path: str, output_dir: str) -> list:
    """Extrai imagens embarcadas do PDF usando pdfimages."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ['pdfimages', '-png', pdf_path, f'{output_dir}/img'],
        check=True, capture_output=True
    )

    images = sorted(Path(output_dir).glob('img-*.png'))
    return [str(p) for p in images]


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


def extract_cnh_data(pdf_path: str, claude_api_key: str = None) -> 'CNHData':
    """
    Pipeline principal de extração.

    Tenta na ordem:
    1. MRZ parse (rápido, grátis, pega nome + data nasc + validade)
    2. OCR por regiões (grátis, pega todos os campos se Tesseract OK)
    3. Claude Vision (pago, mais confiável, fallback inteligente)

    Retorna resultado mesclado das 3 estratégias.
    """
    import tempfile
    import shutil

    output_dir = tempfile.mkdtemp(prefix='cnh_extract_')

    try:
        print(f"[CNH Extractor] Processando: {pdf_path}", file=sys.stderr)

        # Extrair imagens
        images = extract_images_from_pdf(pdf_path, output_dir)
        print(f"  Imagens extraídas: {len(images)}", file=sys.stderr)

        if len(images) < 2:
            raise ValueError(f"PDF não contém imagens suficientes ({len(images)}) para ser uma CNH-e")

        # Identificar imagens por tamanho
        # CNH-e embarca 3 imagens 963x680:
        #   img-001 (~530KB) = frente da CNH (dados pessoais)
        #   img-002 (~170KB) = categorias + observações
        #   img-003 (~280KB) = legenda + MRZ
        from PIL import Image

        main_img = None
        mrz_img = None
        large_images = []

        for img_path in images:
            img = Image.open(img_path)
            w, h = img.size
            file_size = Path(img_path).stat().st_size
            print(f"  {Path(img_path).name}: {w}x{h}, {file_size:,} bytes", file=sys.stderr)

            if w >= 900 and h >= 600:
                large_images.append((img_path, file_size))

        if not large_images:
            raise ValueError("PDF não contém imagens grandes o suficiente — não é uma CNH-e")

        # A maior é a frente da CNH (dados pessoais)
        large_images.sort(key=lambda x: x[1], reverse=True)
        main_img = large_images[0][0]

        # MRZ: testar cada imagem grande que não seja a principal
        for img_path, _ in large_images:
            if img_path == main_img:
                continue
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
        if main_img:
            print("\n  [Estratégia 2] OCR full-page + regex na imagem principal...", file=sys.stderr)
            ocr_data = extract_via_fullpage_ocr(main_img)
            print(f"    Resultado OCR: {ocr_data.to_dict()}", file=sys.stderr)
            results.append(ocr_data)

        # --- Estratégia 3: Claude Vision ---
        if claude_api_key and main_img:
            print("\n  [Estratégia 3] Claude Vision API...", file=sys.stderr)
            try:
                vision_data = extract_via_claude_vision(main_img, claude_api_key)
                print(f"    Resultado Vision: {vision_data.to_dict()}", file=sys.stderr)
                results.append(vision_data)
            except Exception as e:
                print(f"    Claude Vision falhou: {e}", file=sys.stderr)

        # Mesclar resultados (prioridade: Vision > OCR > MRZ se Vision disponível)
        if claude_api_key:
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

    parser = argparse.ArgumentParser(description='Extrai dados de CNH-e digital')
    parser.add_argument('pdf_path', help='Caminho do PDF da CNH-e')
    parser.add_argument('--api-key', help='Anthropic API key (para Claude Vision)')
    parser.add_argument('--json', action='store_true', dest='json_output',
                        help='Output apenas JSON no stdout (logs vão para stderr)')

    args = parser.parse_args()

    result = extract_cnh_data(args.pdf_path, args.api_key)

    if args.json_output:
        print(json.dumps(result.to_dict(), ensure_ascii=False))
    else:
        print("\n" + "=" * 60)
        print("DADOS EXTRAÍDOS DA CNH")
        print("=" * 60)
        for k, v in result.to_dict().items():
            print(f"  {k:25s}: {v}")
