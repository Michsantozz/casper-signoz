import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/features/auth/model/auth";

// Handler de todas as rotas do better-auth (sign-in, callback social, session…).
export const { GET, POST } = toNextJsHandler(auth);
