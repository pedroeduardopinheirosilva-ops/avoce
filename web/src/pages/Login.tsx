import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { queryClient } from "../main";
import { AvoceLockup } from "../components/Logo";

export default function LoginPage() {
  const navigate  = useNavigate();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro,  setErro]  = useState("");

  const login = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      localStorage.setItem("avoce_token", data.token);
      queryClient.clear();
      navigate("/dashboard");
    },
    onError: (e) => setErro(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErro("");
    login.mutate({ email, senha });
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--avoce-navy)" }}
    >
      <div
        style={{
          background: "var(--avoce-paper)",
          border: "var(--avoce-border)",
          width: "100%",
          maxWidth: 360,
          padding: "var(--avoce-space-10)",
          boxShadow: "var(--avoce-shadow-overlay)",
        }}
      >
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "var(--avoce-space-8)" }}>
          <div style={{ display: "inline-flex", justifyContent: "center", marginBottom: "var(--avoce-space-3)" }}>
            <AvoceLockup scale={1.15} />
          </div>
          <p
            style={{
              fontFamily: "var(--avoce-font-mono)",
              fontSize: 10,
              letterSpacing: "var(--avoce-tracking-kicker)",
              textTransform: "uppercase",
              color: "var(--avoce-mute)",
              marginTop: "var(--avoce-space-2)",
            }}
          >
            Plataforma Jurídica
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "var(--avoce-space-4)" }}>
            <label
              style={{
                display: "block",
                fontFamily: "var(--avoce-font-mono)",
                fontSize: 10,
                letterSpacing: "var(--avoce-tracking-kicker)",
                textTransform: "uppercase",
                color: "var(--avoce-mute)",
                marginBottom: "var(--avoce-space-2)",
              }}
            >
              E-mail
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{
                width: "100%",
                border: "var(--avoce-border)",
                background: "var(--avoce-cream)",
                padding: "var(--avoce-space-3) var(--avoce-space-4)",
                fontSize: 14,
                color: "var(--avoce-navy)",
                outline: "none",
                fontFamily: "var(--avoce-font-sans)",
                boxSizing: "border-box",
              }}
              onFocus={e => (e.currentTarget.style.borderColor = "var(--avoce-navy)")}
              onBlur={e => (e.currentTarget.style.borderColor = "var(--avoce-hair)")}
            />
          </div>

          <div style={{ marginBottom: "var(--avoce-space-4)" }}>
            <label
              style={{
                display: "block",
                fontFamily: "var(--avoce-font-mono)",
                fontSize: 10,
                letterSpacing: "var(--avoce-tracking-kicker)",
                textTransform: "uppercase",
                color: "var(--avoce-mute)",
                marginBottom: "var(--avoce-space-2)",
              }}
            >
              Senha
            </label>
            <input
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
              style={{
                width: "100%",
                border: "var(--avoce-border)",
                background: "var(--avoce-cream)",
                padding: "var(--avoce-space-3) var(--avoce-space-4)",
                fontSize: 14,
                color: "var(--avoce-navy)",
                outline: "none",
                fontFamily: "var(--avoce-font-sans)",
                boxSizing: "border-box",
              }}
              onFocus={e => (e.currentTarget.style.borderColor = "var(--avoce-navy)")}
              onBlur={e => (e.currentTarget.style.borderColor = "var(--avoce-hair)")}
            />
          </div>

          {erro && (
            <p style={{ color: "var(--avoce-danger)", fontSize: 13, marginBottom: "var(--avoce-space-3)" }}>
              {erro}
            </p>
          )}

          <button
            type="submit"
            disabled={login.isPending}
            style={{
              width: "100%",
              background: login.isPending ? "var(--avoce-navy-soft)" : "var(--avoce-navy)",
              color: "var(--avoce-cream)",
              border: "none",
              padding: "var(--avoce-space-3) var(--avoce-space-4)",
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "var(--avoce-font-sans)",
              cursor: login.isPending ? "not-allowed" : "pointer",
              opacity: login.isPending ? 0.7 : 1,
              transition: "var(--avoce-transition)",
              letterSpacing: "0.01em",
            }}
          >
            {login.isPending ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
