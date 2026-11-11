import { useParams } from "react-router-dom";
import { useState } from "react";
import { Video, ExternalLink, Clock, ShieldCheck } from "lucide-react";
import { trpc } from "../lib/trpc";
import { useTranscricaoCapture } from "../lib/useTranscricaoCapture";

export default function SalaPublica() {
  const { token } = useParams<{ token: string }>();
  const q = trpc.reunioes.getPublico.useQuery(
    { token: token ?? "" },
    { enabled: !!token, retry: false }
  );

  // Consentimento LGPD — o convidado só é transcrito após autorizar
  const [entrou, setEntrou] = useState(false);
  const [autorizaTranscricao, setAutorizaTranscricao] = useState(true);

  // Transcrição — lado do convidado: captura o próprio mic, rotulado com o nome do contato
  const sessaoId = (q.data as any)?.id as string | undefined;
  const isLive   = (q.data as any)?.status === "em_andamento";
  useTranscricaoCapture({
    sessaoId,
    enabled:    isLive && !!sessaoId && entrou && autorizaTranscricao,
    nome:       (q.data as any)?.contatoNome ?? "Cliente",
    guestToken: token,
  });

  function handleEntrar() {
    if (autorizaTranscricao && sessaoId) {
      fetch(`/api/reuniao/${sessaoId}/consentimento?token=${encodeURIComponent(token ?? "")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => {});
    }
    setEntrou(true);
  }

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

  // em_andamento — tela de consentimento LGPD antes de entrar
  if (!entrou) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="text-center text-gray-600 bg-white rounded-xl shadow-sm p-8 max-w-md w-full">
          <ShieldCheck size={40} className="mx-auto mb-3 text-indigo-500" />
          <h2 className="text-lg font-semibold text-gray-800 mb-2">{(sessao as any).titulo}</h2>
          <p className="text-sm text-gray-500 mb-4">
            Esta videochamada pode ser <strong>gravada e transcrita</strong> para registro do
            atendimento jurídico, nos termos da Lei Geral de Proteção de Dados (LGPD).
            O conteúdo é tratado com confidencialidade e usado exclusivamente no seu caso.
          </p>
          <label className="flex items-start gap-2 text-left text-sm text-gray-700 mb-5 cursor-pointer">
            <input
              type="checkbox"
              checked={autorizaTranscricao}
              onChange={e => setAutorizaTranscricao(e.target.checked)}
              className="mt-0.5 accent-indigo-600"
            />
            <span>Autorizo a gravação e a transcrição da minha fala nesta reunião.</span>
          </label>
          <button
            onClick={handleEntrar}
            className="w-full bg-indigo-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-indigo-700">
            Entrar na reunião
          </button>
          {!autorizaTranscricao && (
            <p className="text-[11px] text-gray-400 mt-3">
              Você entrará normalmente, mas sua fala não será transcrita.
            </p>
          )}
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
