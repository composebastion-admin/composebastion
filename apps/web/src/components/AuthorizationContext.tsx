import { createContext, useContext, type ReactNode } from "react";
import type { AdminUser } from "@composebastion/shared";
import { authorizationForRole, type Authorization } from "../lib/authorization.js";

const AuthorizationContext = createContext<Authorization>(authorizationForRole("viewer"));

export function AuthorizationProvider({ role, children }: { role: AdminUser["role"]; children: ReactNode }) {
  return (
    <AuthorizationContext.Provider value={authorizationForRole(role)}>
      {children}
    </AuthorizationContext.Provider>
  );
}

export function useAuthorization() {
  return useContext(AuthorizationContext);
}
