import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout     from "./components/Layout";
import LoginPage  from "./pages/Login";
import Dashboard  from "./pages/Dashboard";
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
import Pipedrive           from "./pages/Pipedrive";
import Reengajamento       from "./pages/Reengajamento";
import Financeiro          from "./pages/Financeiro";
import Usuarios           from "./pages/Usuarios";
import ContasBancarias    from "./pages/Financeiro/ContasBancarias";
import ContaBancariaForm  from "./pages/Financeiro/ContaBancariaForm";
import Extrato            from "./pages/Financeiro/Extrato";
import Conciliacao        from "./pages/Financeiro/Conciliacao";
import FluxoCaixa         from "./pages/Financeiro/FluxoCaixa";

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("avoce_token");
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route index element={<Navigate to="/crm" replace />} />
          <Route path="crm" element={<Crm />} />
          <Route path="whatsapp"   element={<Whatsapp />} />
          <Route path="config-ia"  element={<ConfigIA />} />
          <Route path="dashboard"  element={<Dashboard />} />
          <Route path="empresas"   element={<Empresas />} />
          <Route path="tomadores"  element={<Tomadores />} />
          <Route path="contratos"  element={<Contratos />} />
          <Route path="faturamento" element={<Faturamento />} />
          <Route path="notas"      element={<Notas />} />
          <Route path="cobrancas"  element={<Cobrancas />} />
          <Route path="propostas"           element={<Propostas />} />
          <Route path="templates-documentos" element={<TemplatesDocumentos />} />
          <Route path="pipedrive"           element={<Pipedrive />} />
          <Route path="reengajamento"       element={<Reengajamento />} />
          <Route path="financeiro"          element={<Financeiro />} />
          <Route path="financeiro/contas"   element={<ContasBancarias />} />
          <Route path="financeiro/contas/nova" element={<ContaBancariaForm />} />
          <Route path="financeiro/contas/:id"  element={<ContaBancariaForm />} />
          <Route path="financeiro/extrato"     element={<Extrato />} />
          <Route path="financeiro/conciliacao" element={<Conciliacao />} />
          <Route path="financeiro/fluxo-caixa" element={<FluxoCaixa />} />
          <Route path="usuarios"            element={<Usuarios />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
