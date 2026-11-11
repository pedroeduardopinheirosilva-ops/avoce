import { useEffect, useRef } from "react";

/**
 * Captura o microfone LOCAL do participante e envia falas rotuladas ao backend.
 * Identificação de interlocutor sem diarização: 1 microfone = 1 página = 1 papel.
 *
 * - Caminho 1 (Chrome/Edge): Web Speech API — transcreve no próprio browser, custo zero.
 * - Caminho 2 (Safari/iOS): MediaRecorder em ciclos de 20s → servidor → Whisper.
 */
interface Opts {
  sessaoId?: string;
  enabled: boolean;
  nome?: string;       // nome exibido do falante
  guestToken?: string; // presente = SalaPublica (auth por tokenConvidado); ausente = Bearer JWT
}

export function useTranscricaoCapture({ sessaoId, enabled, nome, guestToken }: Opts) {
  const elapsedRef = useRef(0);
  const nomeRef    = useRef(nome);
  nomeRef.current  = nome;

  useEffect(() => {
    if (!enabled || !sessaoId) return;

    let ativo = true;
    elapsedRef.current = 0;
    const elapsedTimer = setInterval(() => { elapsedRef.current++; }, 1000);

    const qs = guestToken ? `?token=${encodeURIComponent(guestToken)}` : "";
    const authHeader = (): Record<string, string> =>
      guestToken ? {} : { Authorization: `Bearer ${localStorage.getItem("avoce_token") ?? ""}` };

    function sendTexto(texto: string) {
      if (!texto.trim()) return;
      fetch(`/api/reuniao/${sessaoId}/transcricao-texto${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ texto, nome: nomeRef.current, inicioSegundos: elapsedRef.current }),
      }).catch(() => {});
    }

    function sendAudio(blob: Blob) {
      if (blob.size < 4000) return; // silêncio / chunk vazio
      const fd = new FormData();
      fd.append("audio", blob, "chunk.webm");
      fd.append("nome", nomeRef.current ?? "");
      fd.append("inicioSegundos", String(elapsedRef.current));
      fetch(`/api/reuniao/${sessaoId}/transcricao-chunk${qs}`, {
        method: "POST",
        headers: authHeader(),
        body: fd,
      }).catch(() => {});
    }

    // ── Caminho 1: Web Speech API ────────────────────────────────────────────
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    let recognition: any = null;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let cicloTimeout: ReturnType<typeof setTimeout> | null = null;

    if (SR) {
      recognition = new SR();
      recognition.lang = "pt-BR";
      recognition.continuous = true;
      recognition.interimResults = false;

      recognition.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            const texto = e.results[i][0].transcript?.trim();
            if (texto) sendTexto(texto);
          }
        }
      };
      // Web Speech para sozinho — reinicia enquanto a captura estiver ativa
      recognition.onend = () => {
        if (ativo) setTimeout(() => { try { recognition.start(); } catch { /* já rodando */ } }, 300);
      };
      recognition.onerror = (e: any) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") ativo = false;
      };
      try { recognition.start(); } catch { /* permissão negada */ }
    } else if (window.MediaRecorder) {
      // ── Caminho 2: MediaRecorder em ciclos de 20s → Whisper ────────────────
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(s => {
        if (!ativo) { s.getTracks().forEach(t => t.stop()); return; }
        stream = s;
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";

        function iniciarCiclo() {
          if (!ativo || !stream) return;
          const chunks: Blob[] = [];
          recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
          recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
          recorder.onstop = () => {
            if (chunks.length > 0) sendAudio(new Blob(chunks, { type: recorder?.mimeType || "audio/webm" }));
            iniciarCiclo();
          };
          recorder.start();
          cicloTimeout = setTimeout(() => {
            if (recorder?.state === "recording") recorder.stop();
          }, 20_000);
        }
        iniciarCiclo();
      }).catch(() => { /* microfone negado — segue sem transcrição */ });
    }

    return () => {
      ativo = false;
      clearInterval(elapsedTimer);
      if (cicloTimeout) clearTimeout(cicloTimeout);
      try { recognition?.stop(); } catch { /* noop */ }
      if (recorder?.state === "recording") { recorder.onstop = null; recorder.stop(); }
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [enabled, sessaoId, guestToken]);
}
