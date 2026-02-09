"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Moon02Icon, Sun02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function Header() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Notify Electron to update titlebar overlay when theme changes
  useEffect(() => {
    if (!mounted) return;
    const isDark = theme === "dark";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    api?.setTitleBarTheme?.(isDark);
  }, [theme, mounted]);

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/50 bg-background px-4">
      <div className="ml-auto flex items-center gap-2">
        {mounted && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="h-7 w-7"
              >
                {theme === "dark" ? (
                  <HugeiconsIcon icon={Sun02Icon} className="h-4 w-4" />
                ) : (
                  <HugeiconsIcon icon={Moon02Icon} className="h-4 w-4" />
                )}
                <span className="sr-only">Toggle theme</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
