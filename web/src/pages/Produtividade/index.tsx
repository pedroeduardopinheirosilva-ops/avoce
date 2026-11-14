import { useState } from "react";
import { Activity } from "lucide-react";
import { useAuth } from "../../lib/usePermission";
import Equipe from "./Equipe";
import Pessoa from "./Pessoa";
import Regras from "./Regras";
import Dispositivos from "./Dispositivos";
import { hojeStr } from "./util";

type Aba = "equipe" | "pessoa" | "regras" | "dispositivos";
const ABAS: { id: Aba; rotulo: string }[] = [
  { id: "equipe", rotulo: "Equipe" },
  { id: "pessoa", rotulo: "Pessoa" },
  { id: "regras", rotulo: "Regras" },
  { id: "dispositivos", rotulo: "Dispositivos" },
];

export default function Produtividade() {
  const { user } = useAuth();
  const [aba, setAba] = useState<Aba>("equipe");
  const [usuarioId, setUsuarioId] = useState<string | null>(null);
  const [dia, setDia] = useState(hojeStr());

  if (user?.verProdutividade !== true) {
    return (
      <div className="p-8 text-center text-gray-500">
        Sem permissão para acessar o monitor de produtividade.
      </div>
    );
  }

  const abrirPessoa = (id: string, d?: string) => {
    setUsuarioId(id);
    if (d) setDia(d);
    setAba("pessoa");
  };

  return (
    <div className="p-6 space-y-4" style={{ fontFamily: "var(--avoce-font-sans)" }}>
      <h1 className="text-lg font-bold flex items-center gap-2" style={{ color: "var(--avoce-navy)" }}>
        <Activity size={20} /> Produtividade
      </h1>
      <div className="flex gap-1 border-b border-gray-200">
        {ABAS.map((a) => (
          <button
            key={a.id}
            onClick={() => setAba(a.id)}
            className="px-4 py-2 text-sm -mb-px border-b-2"
            style={{
              borderColor: aba === a.id ? "var(--avoce-gold)" : "transparent",
              color: aba === a.id ? "var(--avoce-navy)" : "var(--avoce-mute)",
              fontWeight: aba === a.id ? 600 : 500,
            }}
          >
            {a.rotulo}
          </button>
        ))}
      </div>
      {aba === "equipe" && <Equipe dia={dia} setDia={setDia} onAbrir={abrirPessoa} />}
      {aba === "pessoa" && <Pessoa usuarioId={usuarioId} setUsuarioId={setUsuarioId} dia={dia} setDia={setDia} />}
      {aba === "regras" && <Regras />}
      {aba === "dispositivos" && <Dispositivos />}
    </div>
  );
}
