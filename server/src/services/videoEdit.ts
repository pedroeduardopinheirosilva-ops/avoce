/**
 * Edição de vídeo com FFmpeg — legendas, formato 9:16, vinheta
 * FFmpeg deve estar instalado no servidor (apt install ffmpeg)
 */

import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const execAsync = promisify(exec);

function garantirDiretorio(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Converte vídeo para formato Reels (9:16, 1080x1920, H.264)
export async function converterParaReels(inputPath: string, outputPath: string): Promise<void> {
  garantirDiretorio(outputPath);
  const cmd = `ffmpeg -i "${inputPath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -y "${outputPath}"`;
  const { stderr } = await execAsync(cmd, { timeout: 300_000 });
  if (stderr && !stderr.includes("video:")) {
    console.warn("[VideoEdit] ffmpeg stderr:", stderr.slice(-500));
  }
}

// Adiciona legenda SRT ao vídeo
export async function adicionarLegenda(
  inputPath: string,
  srtPath: string,
  outputPath: string,
  estilo = "FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2",
): Promise<void> {
  garantirDiretorio(outputPath);
  const cmd = `ffmpeg -i "${inputPath}" -vf "subtitles='${srtPath}':force_style='${estilo}'" -c:v libx264 -preset fast -crf 23 -c:a copy -y "${outputPath}"`;
  await execAsync(cmd, { timeout: 300_000 });
}

// Concatena vinheta de intro + vídeo principal + vinheta de outro
export async function adicionarVinheta(
  inputPath: string,
  introPath: string | null,
  outroPath: string | null,
  outputPath: string,
): Promise<void> {
  garantirDiretorio(outputPath);

  if (!introPath && !outroPath) {
    // Nada a fazer, só copia
    await execAsync(`ffmpeg -i "${inputPath}" -c copy -y "${outputPath}"`);
    return;
  }

  const tmpList = join(dirname(outputPath), `_concat_${Date.now()}.txt`);
  const partes: string[] = [];
  if (introPath) partes.push(`file '${introPath}'`);
  partes.push(`file '${inputPath}'`);
  if (outroPath) partes.push(`file '${outroPath}'`);

  const { writeFileSync, unlinkSync } = await import("fs");
  writeFileSync(tmpList, partes.join("\n"));

  try {
    const cmd = `ffmpeg -f concat -safe 0 -i "${tmpList}" -c:v libx264 -preset fast -crf 23 -c:a aac -y "${outputPath}"`;
    await execAsync(cmd, { timeout: 300_000 });
  } finally {
    unlinkSync(tmpList);
  }
}

// Extrai áudio de vídeo para transcrição (reutiliza whisper.ts do Avoce)
export async function extrairAudio(inputPath: string, outputPath: string): Promise<void> {
  garantirDiretorio(outputPath);
  const cmd = `ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y "${outputPath}"`;
  await execAsync(cmd, { timeout: 120_000 });
}

// Gera arquivo SRT simples a partir de transcrição em texto puro
export function textoParaSrt(texto: string, duracaoSegundos: number): string {
  const palavras = texto.trim().split(/\s+/);
  const wordsPerBlock = 8;
  const blocks: string[] = [];
  let idx = 1;
  let start = 0;

  for (let i = 0; i < palavras.length; i += wordsPerBlock) {
    const bloco = palavras.slice(i, i + wordsPerBlock).join(" ");
    const end = Math.min(start + (duracaoSegundos / Math.ceil(palavras.length / wordsPerBlock)), duracaoSegundos);
    blocks.push(`${idx}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${bloco}`);
    start = end;
    idx++;
  }
  return blocks.join("\n\n");
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}
