"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NavRail } from "./NavRail";
import { ChatListPanel } from "./ChatListPanel";
import { RightPanel } from "./RightPanel";
import { PanelContext, type PanelContent } from "@/hooks/usePanel";

const LG_BREAKPOINT = 1024;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const [chatListOpen, setChatListOpenRaw] = useState(false);

  // Panel state
  const isChatRoute = pathname.startsWith("/chat/") || pathname === "/chat";
  const isChatDetailRoute = pathname.startsWith("/chat/");

  // Auto-close chat list when leaving chat routes
  const setChatListOpen = useCallback((open: boolean) => {
    setChatListOpenRaw(open);
  }, []);

  useEffect(() => {
    if (!isChatRoute) {
      setChatListOpenRaw(false);
    }
  }, [isChatRoute]);
  const [panelOpen, setPanelOpenRaw] = useState(false);
  const [panelContent, setPanelContent] = useState<PanelContent>("files");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [streamingSessionId, setStreamingSessionId] = useState("");
  const [pendingApprovalSessionId, setPendingApprovalSessionId] = useState("");

  // Auto-open panel on chat detail routes, close on others
  useEffect(() => {
    setPanelOpenRaw(isChatDetailRoute);
  }, [isChatDetailRoute]);

  // Listen for "Open with CodePilot" context menu / second-instance folder open
  useEffect(() => {
    (window as any).electronAPI?.onOpenFolder?.((folderPath: string) => {
      setWorkingDirectory(folderPath);
      router.push('/chat');
    });
  }, []);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenRaw(open);
  }, []);

  // Keep chat list state in sync when resizing across the breakpoint (only on chat routes)
  useEffect(() => {
    if (!isChatRoute) return;
    const mql = window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setChatListOpenRaw(e.matches);
    mql.addEventListener("change", handler);
    setChatListOpenRaw(mql.matches);
    return () => mql.removeEventListener("change", handler);
  }, [isChatRoute]);

  const panelContextValue = useMemo(
    () => ({
      panelOpen,
      setPanelOpen,
      panelContent,
      setPanelContent,
      workingDirectory,
      setWorkingDirectory,
      sessionId,
      setSessionId,
      sessionTitle,
      setSessionTitle,
      streamingSessionId,
      setStreamingSessionId,
      pendingApprovalSessionId,
      setPendingApprovalSessionId,
    }),
    [panelOpen, setPanelOpen, panelContent, workingDirectory, sessionId, sessionTitle, streamingSessionId, pendingApprovalSessionId]
  );

  return (
    <PanelContext.Provider value={panelContextValue}>
      <TooltipProvider delayDuration={300}>
        <div className="flex h-screen overflow-hidden">
          <NavRail
            chatListOpen={chatListOpen}
            onToggleChatList={() => setChatListOpen(!chatListOpen)}
          />
          <ChatListPanel open={chatListOpen} />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* Electron draggable title bar region */}
            <div
              className="h-11 w-full shrink-0"
              style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
            />
            <main className="relative flex-1 overflow-hidden">{children}</main>
          </div>
          {isChatDetailRoute && <RightPanel />}
        </div>
      </TooltipProvider>
    </PanelContext.Provider>
  );
}
