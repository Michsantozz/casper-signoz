import "server-only";

// Ponte de leitura para RSC: `_pages` não pode tocar `server/*` — o `api/` do
// slice é a única parte que atravessa (mesma regra das Server Actions). Não
// reexportar no index.ts do slice: o barrel é consumido por client components
// e este módulo é server-only.
export { getPublicMeeting } from "@/server/recall/public-meeting";
