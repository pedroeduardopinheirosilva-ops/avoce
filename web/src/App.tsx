import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import Layout     from "./components/Layout";
import Disparos           from "./pages/Disparos";
import LoginPage  from "./pages/Login";
import { VoipProvider } from "./contexts/VoipContext";
import Dashboard  from "./pages/Dashboard";
import Painel     from "./pages/Painel";
import Empresas   from "./pages/Empresas";
import Tomadores  from "./pages/Tomadores";
import Contratos  from "./pages/Contratos";
import Notas        from "./pages/Notas";
import Cobrancas    from "./pages/Cobrancas";
import Faturamento  from "./pages/Faturamento";
import Propostas           from "./pages/Propostas";
import TemplatesDocumentos from "./pages/TemplatesDocumentos";
import Crm                 from "./pages/Crm";
import Whatsapp            from "./pages/Whatsapp";
import ConfigIA            from "./pages/ConfigIA";
import Financeiro          from "./pages/Financeiro";
import Usuarios           from "./pages/Usuarios";
import AssistenteInterno  from "./pages/AssistenteInterno";
import ContasBancarias    from "./pages/Financeiro/ContasBancarias";
import ContaBancariaForm  from "./pages/Financeiro/ContaBancariaForm";
import Extrato            from "./pages/Financeiro/Extrato";
import Conciliacao        from "./pages/Financeiro/Conciliacao";
import FluxoCaixa         from "./pages/Financeiro/FluxoCaixa";
import PainelFinanceiro   from "./pages/Financeiro/PainelFinanceiro";
import OrcadoRealizado    from "./pages/Financeiro/OrcadoRealizado";
import FontesRecursos     from "./pages/Financeiro/Fontes";
import EmprestimoPsa      from "./pages/Financeiro/EmprestimoPsa";
import EmprestimoBancario from "./pages/Financeiro/EmprestimoBancario";
import Aplicacoes         from "./pages/Financeiro/Aplicacoes";
import IndicesFin         from "./pages/Financeiro/Indices";
import LogAlteracoesFin   from "./pages/Financeiro/LogAlteracoes";
import { FluxoProjetado, Dre as DreGerencial, ConsumoFonte } from "./pages/Financeiro/Relatorios";
import Reunioes           from "./pages/Reunioes";
import Telefone           from "./pages/Telefone";
import SalaPublica        from "./pages/SalaPublica";
import Tenants            from "./pages/Tenants";
import Assinaturas        from "./pages/Assinaturas";
import Acordos            from "./pages/Acordos";
import Recebimentos       from "./pages/Recebimentos";
import { trpc } from "./lib/trpc";
import { AuthContext, type AuthUser } from "./lib/usePermission";

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("avoce_token");
  const { data: user, isLoading, error } = trpc.auth.me.useQuery(undefined, {
    enabled: !!token,
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (error) {
      localStorage.removeItem("avoce_token");
    }
  }, [error]);

  if (!token) return <Navigate to="/login" replace />;
  if (isLoading) return <div style={{ padding: "2rem", textAlign: "center", color: "#666" }}>Carregando…</div>;
  if (error) return <Navigate to="/login" replace />;

  return (
    <AuthContext.Provider value={{ user: user as AuthUser, isLoading: false }}>
      {children}
    </AuthContext.Provider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/sala/:token" element={<SalaPublica />} />
        <Route path="/" element={<PrivateRoute><VoipProvider><Layout /></VoipProvider></PrivateRoute>}>
          <Route index element={<Navigate to="/crm" replace />} />
          <Route path="crm" element={<Crm />} />
          <Route path="whatsapp"   element={<Whatsapp />} />
          <Route path="config-ia"  element={<ConfigIA />} />
          <Route path="dashboard"  element={<Dashboard />} />
          <Route path="painel"     element={<Painel />} />
          <Route path="empresas"   element={<Empresas />} />
          <Route path="tomadores"  element={<Tomadores />} />
          <Route path="contratos"  element={<Contratos />} />
          <Route path="faturamento" element={<Faturamento />} />
          <Route path="notas"      element={<Notas />} />
          <Route path="cobrancas"  element={<Cobrancas />} />
          <Route path="propostas"           element={<Propostas />} />
          <Route path="templates-documentos" element={<TemplatesDocumentos />} />
          <Route path="assinaturas"         element={<Assinaturas />} />
          <Route path="acordos/:id?"        element={<Acordos />} />
          <Route path="recebimentos"        element={<Recebimentos />} />
          <Route path="financeiro"          element={<Financeiro />} />
          <Route path="financeiro/contas"   element={<ContasBancarias />} />
          <Route path="financeiro/contas/nova" element={<ContaBancariaForm />} />
          <Route path="financeiro/contas/:id"  element={<ContaBancariaForm />} />
          <Route path="financeiro/extrato"     element={<Extrato />} />
          <Route path="financeiro/conciliacao" element={<Conciliacao />} />
          <Route path="financeiro/fluxo-caixa" element={<FluxoCaixa />} />
          <Route path="financeiro/painel"      element={<PainelFinanceiro />} />
          <Route path="financeiro/orcamento"   element={<OrcadoRealizado />} />
          <Route path="financeiro/fontes"      element={<FontesRecursos />} />
          <Route path="financeiro/emprestimos" element={<Navigate to="/financeiro/emprestimos/psa" replace />} />
          <Route path="financeiro/emprestimos/psa"      element={<EmprestimoPsa />} />
          <Route path="financeiro/emprestimos/bancario" element={<EmprestimoBancario />} />
          <Route path="financeiro/aplicacoes"  element={<Aplicacoes />} />
          <Route path="financeiro/indices"     element={<IndicesFin />} />
          <Route path="financeiro/relatorios"  element={<Navigate to="/financeiro/relatorios/fluxo" replace />} />
          <Route path="financeiro/relatorios/fluxo"   element={<FluxoProjetado />} />
          <Route path="financeiro/relatorios/dre"     element={<DreGerencial />} />
          <Route path="financeiro/relatorios/consumo" element={<ConsumoFonte />} />
          <Route path="financeiro/log"         element={<LogAlteracoesFin />} />
          <Route path="usuarios"            element={<Usuarios />} />
          <Route path="tenants"             element={<Tenants />} />
          <Route path="assistente-interno"  element={<AssistenteInterno />} />
          <Route path="reunioes"           element={<Reunioes />} />
          <Route path="agenda"             element={<Reunioes abaInicial="agenda" />} />
          <Route path="telefone"           element={<Telefone />} />
          <Route path="disparos"            element={<Disparos />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
