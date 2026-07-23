"use client";

import type { FC, PropsWithChildren } from "react";

import { Thread } from "@/shared/ui/assistant-ui/thread";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/ui/resizable";

/**
 * AssistantSidebar — layout de duas colunas redimensionáveis com o `Thread`
 * real do assistant-ui à direita (composição do guia:
 * ResizablePanelGroup [children | ResizableHandle | Thread]).
 *
 * O `Thread` completo (mensagens, action bar, branch picker, markdown,
 * reasoning, tool UIs, composer terminal EvilCharts) já herda a style do
 * projeto — este componente só o encaixa numa sidebar redimensionável.
 *
 * Deve viver abaixo de um `AssistantRuntimeProvider` (o chamador liga o
 * runtime, ex.: useChatRuntime → /api/chat).
 */
export const AssistantSidebar: FC<
  PropsWithChildren<{ defaultSize?: number; sidebarSize?: number }>
> = ({ children, defaultSize = 65, sidebarSize = 35 }) => {
  // v4 do react-resizable-panels só calcula o flexGrow dos painéis no client,
  // após medir o container. Sem um `defaultLayout` (map id→flexGrow) o primeiro
  // paint (SSR/hydration) sai com os painéis colapsados numa tira estreita e só
  // "abre" depois que o JS hidrata — o flash que aparecia no carregamento.
  // Fixando ids + defaultLayout, o layout já vem correto no server render.
  const layout = { main: defaultSize, thread: sidebarSize };
  return (
    <ResizablePanelGroup orientation="horizontal" defaultLayout={layout}>
      <ResizablePanel id="main" defaultSize={defaultSize} minSize={30}>
        {children}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="thread" defaultSize={sidebarSize} minSize={22}>
        <Thread />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
};
