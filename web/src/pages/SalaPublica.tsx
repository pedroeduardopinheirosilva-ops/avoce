import { useParams } from "react-router-dom";
import { useEffect, useRef } from "react";
import { Video, ExternalLink, Clock } from "lucide-react";
import { trpc } from "../lib/trpc";

export default function SalaPublica() {
  const { token } = useParams<{ token: string }>();
  const q = trpc.reunioes.getPublico.useQuery(
    { token: token ?? "" },
    { enabled: !!token, retry: false }
  );

  // Auto-recording — guest side (uses tokenConvidado for auth)
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const sessaoId    = (q.data as any)?.id as string | undefined;
  const isLive      = (q.data as any)?.status === "em_andamento";

  function sendChunk(id: string, blob: Blob) {
    if (blob.size < 1000) return;
    const fd = new FormData();
    fd.append("audio", blob, "chunk.webm");
    fetch(`/api/reuniao/${id}/transcricao-chunk?token=${encodeURIComponent(token ?? "")}`, {
      method: "POST",
      body: fd,
    }).catch(() => {});
  }

  useEffect(() => {
    if (!isLive || !sessaoId) return;

    navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream => {
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        sendChunk(sessaoId, blob);
        chunksRef.current = [];
      };

      recorder.start();
      intervalRef.current = setInterval(() => {
        if (recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
          setTimeout(() => { recorderRef.current?.start(); }, 200);
        }
      }, 30_000);
    }).catch(() => {});

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [isLive, sessaoId]);

  if (q.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center text-gray-500">
          <Video size={40} className="mx-auto mb-3 opacity-30 animate-pulse" />
          <p>Carregando reunião...</p>
        </div>
      </div>
    );
  }

  if (q.error) {
    const msg = (q.error as any)?.message ?? "Reunião não encontrada";
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center text-gray-600 bg-white rounded-xl shadow-sm p-10 max-w-sm">
          <Video size={40} className="mx-auto mb-3 opacity-30" />
          <h2 className="text-lg font-semibold text-gray-800 mb-2">Sala não disponível</h2>
          <p className="text-sm text-gray-500">{msg}</p>
        </div>
      </div>
    );
  }

  const sessao = q.data;
  if (!sessao) return null;

  if ((sessao as any).status === "agendada") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center text-gray-600 bg-white rounded-xl shadow-sm p-10 max-w-sm">
          <Clock size={40} className="mx-auto mb-3 text-indigo-400" />
          <h2 className="text-lg font-semibold text-gray-800 mb-2">{(sessao as any).titulo}</h2>
          <p className="text-sm text-gray-500 mb-6">A reunião ainda não foi iniciada. Aguarde o anfitrião iniciar a sala.</p>
          <button onClick={() => window.location.reload()}
            className="text-sm border rounded-lg px-4 py-2 hover:bg-gray-50">
            Atualizar
          </button>
        </div>
      </div>
    );
  }

  // em_andamento — embed Jitsi
  return (
    <div className="min-h-screen flex flex-col bg-gray-900">
      <div className="bg-gray-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-white">
          <Video size={18} className="text-indigo-400" />
          <span className="font-medium text-sm">{(sessao as any).titulo}</span>
          <span className="text-xs bg-green-500 text-white px-2 py-0.5 rounded-full">Ao vivo</span>
        </div>
        <a href={(sessao as any).jitsiUrl} target="_blank" rel="noopener noreferrer"
          className="text-xs text-gray-300 hover:text-white flex items-center gap-1">
          <ExternalLink size={12} /> Abrir em nova aba
        </a>
      </div>
      <iframe
        src={(sessao as any).jitsiUrl}
        className="flex-1 border-0"
        style={{ minHeight: "calc(100vh - 48px)" }}
        allow="camera; microphone; display-capture; fullscreen; autoplay"
        title={(sessao as any).titulo}
      />
    </div>
  );
}
