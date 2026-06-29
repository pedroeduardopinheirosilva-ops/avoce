import { createContext, useContext } from "react";

export interface AuthUser {
  id: string;
  nome: string;
  email: string;
  empresaId: string | null;
  role: string;
  permissoes: { modulos?: string[]; emitentes?: string[]; empresas_full?: string[] } | null;
}

export interface AuthCtx {
  user: AuthUser | null;
  isLoading: boolean;
}

export function hasModulo(user: AuthUser | null, modulo: string): boolean {
  if (!user) return true; // will redirect to login anyway
  if (user.role === "admin" && !user.empresaId) return true; // global admin
  if (!user.permissoes) return true; // null = full access
  if (!user.permissoes.modulos) return true; // no module restriction
  return user.permissoes.modulos.includes(modulo);
}

export function canAccessEmitente(user: AuthUser | null, emitenteId: string): boolean {
  if (!user) return true;
  if (user.role === "admin" && !user.empresaId) return true;
  if (!user.permissoes) return true;
  if (!user.permissoes.emitentes) return true;
  return user.permissoes.emitentes.includes(emitenteId);
}

export const AuthContext = createContext<AuthCtx>({ user: null, isLoading: true });

export function useAuth() {
  return useContext(AuthContext);
}

export function hasFullAccess(user: AuthUser | null): boolean {
  if (!user) return false;
  if (user.role === "admin" && !user.empresaId) return true;
  return user.permissoes === null;
}
