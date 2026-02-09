"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import type { ApiProvider } from "@/types";

const PROVIDER_PRESETS: Record<string, { base_url: string; extra_env: string }> = {
  anthropic: { base_url: "https://api.anthropic.com", extra_env: "{}" },
  openrouter: { base_url: "https://openrouter.ai/api", extra_env: '{"ANTHROPIC_API_KEY":""}' },
  bedrock: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_BEDROCK":"1","AWS_REGION":"us-east-1","CLAUDE_CODE_SKIP_BEDROCK_AUTH":"1"}' },
  vertex: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_VERTEX":"1","CLOUD_ML_REGION":"us-east5","CLAUDE_CODE_SKIP_VERTEX_AUTH":"1"}' },
  antigravity: { base_url: "", extra_env: '{}' },
  custom: { base_url: "", extra_env: "{}" },
};

const PROVIDER_TYPES = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "vertex", label: "Google Vertex" },
  { value: "antigravity", label: "Google Antigravity" },
  { value: "custom", label: "Custom" },
];

interface ProviderFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  provider?: ApiProvider | null;
  onSave: (data: ProviderFormData) => Promise<void>;
  initialPreset?: { name: string; provider_type: string; base_url: string; extra_env?: string } | null;
}

export interface ProviderFormData {
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  extra_env: string;
  notes: string;
}

export function ProviderForm({
  open,
  onOpenChange,
  mode,
  provider,
  onSave,
  initialPreset,
}: ProviderFormProps) {
  const [name, setName] = useState("");
  const [providerType, setProviderType] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [extraEnv, setExtraEnv] = useState("{}");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);

    if (mode === "edit" && provider) {
      setName(provider.name);
      setProviderType(provider.provider_type);
      setBaseUrl(provider.base_url);
      setApiKey("");
      setExtraEnv(provider.extra_env || "{}");
      setNotes(provider.notes || "");
      // Show advanced if extra_env has content
      try {
        const parsed = JSON.parse(provider.extra_env || "{}");
        setShowAdvanced(Object.keys(parsed).length > 0);
      } catch {
        setShowAdvanced(true);
      }
    } else if (initialPreset) {
      setName(initialPreset.name);
      setProviderType(initialPreset.provider_type);
      setBaseUrl(initialPreset.base_url);
      setApiKey("");
      // Use extra_env from preset if provided, otherwise look up by type
      const envStr = initialPreset.extra_env || PROVIDER_PRESETS[initialPreset.provider_type]?.extra_env || "{}";
      setExtraEnv(envStr);
      setNotes("");
      try {
        const parsed = JSON.parse(envStr);
        setShowAdvanced(Object.keys(parsed).length > 0);
      } catch {
        setShowAdvanced(false);
      }
    } else {
      setName("");
      setProviderType("anthropic");
      setBaseUrl(PROVIDER_PRESETS.anthropic.base_url);
      setApiKey("");
      setExtraEnv("{}");
      setNotes("");
      setShowAdvanced(false);
    }
  }, [open, mode, provider, initialPreset]);

  const handleTypeChange = (type: string) => {
    setProviderType(type);
    const preset = PROVIDER_PRESETS[type];
    if (preset) {
      setBaseUrl(preset.base_url);
      setExtraEnv(preset.extra_env);
      try {
        const parsed = JSON.parse(preset.extra_env);
        setShowAdvanced(Object.keys(parsed).length > 0);
      } catch {
        setShowAdvanced(false);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    // Validate extra_env JSON
    try {
      JSON.parse(extraEnv);
    } catch {
      setError("Extra environment variables must be valid JSON");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        provider_type: providerType,
        base_url: baseUrl.trim(),
        api_key: apiKey,
        extra_env: extraEnv,
        notes: notes.trim(),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  };

  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthEmail, setOauthEmail] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const isMaskedKey = mode === "edit" && provider?.api_key?.startsWith("***");
  const supportsSubscription = providerType === "anthropic";
  const isAntigravity = providerType === "antigravity";

  const handleAntigravityLogin = async () => {
    setOauthLoading(true);
    setOauthError(null);
    setOauthEmail(null);
    try {
      const res = await fetch("/api/providers/antigravity-auth", { method: "POST" });
      if (!res.ok) throw new Error("Failed to start OAuth");
      const { authUrl } = await res.json();

      // Open Google OAuth in system default browser (not Electron's Chromium)
      if ((window as any).electronAPI?.openExternal) {
        (window as any).electronAPI.openExternal(authUrl);
      } else {
        window.open(authUrl, "_blank");
      }

      // Poll for completion (every 2s, up to 5 minutes)
      const maxAttempts = 150;
      let consecutiveErrors = 0;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const pollRes = await fetch("/api/providers/antigravity-auth");
          if (!pollRes.ok) {
            consecutiveErrors++;
            if (consecutiveErrors >= 3) {
              throw new Error(`Poll request failed with status ${pollRes.status}`);
            }
            continue; // Retry on transient HTTP errors
          }
          consecutiveErrors = 0;
          const pollData = await pollRes.json();
          if (pollData.status === "complete") {
            setApiKey(pollData.refreshToken);
            setOauthEmail(pollData.email || null);
            setOauthLoading(false);
            return;
          }
          if (pollData.status === "error") {
            throw new Error(pollData.error || "OAuth failed");
          }
          // "pending" -> continue polling
        } catch (pollErr) {
          // Re-throw intentional errors (from status checks above)
          if (pollErr instanceof Error && (pollErr.message.includes("OAuth failed") || pollErr.message.includes("Poll request failed"))) {
            throw pollErr;
          }
          // Network errors: tolerate a few before giving up
          consecutiveErrors++;
          if (consecutiveErrors >= 3) {
            throw new Error("Network error while polling for OAuth completion");
          }
          // Otherwise continue polling
        }
      }
      throw new Error("OAuth timed out");
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : "OAuth failed");
    } finally {
      setOauthLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[28rem] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit Provider" : "Add Provider"}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "Update the API provider configuration."
              : "Configure a new API provider for Claude Code."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 min-w-0">
          <div className="space-y-2">
            <Label htmlFor="provider-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="provider-name"
              placeholder="My API Provider"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-type" className="text-xs text-muted-foreground">
              Provider Type
            </Label>
            <Select value={providerType} onValueChange={handleTypeChange}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isAntigravity && (
          <div className="space-y-2">
            <Label htmlFor="provider-base-url" className="text-xs text-muted-foreground">
              API Base URL
            </Label>
            <Input
              id="provider-base-url"
              placeholder="https://api.anthropic.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          )}

          {isAntigravity ? (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                Google Authentication
              </Label>
              {apiKey ? (
                <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3">
                  <p className="text-xs font-medium text-green-700 dark:text-green-400">
                    {oauthEmail ? `Authenticated as ${oauthEmail}` : "Google account connected"}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Refresh token stored. Click below to re-authenticate.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 gap-2"
                    onClick={handleAntigravityLogin}
                    disabled={oauthLoading}
                  >
                    {oauthLoading && <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />}
                    Re-authenticate
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full gap-2"
                    onClick={handleAntigravityLogin}
                    disabled={oauthLoading}
                  >
                    {oauthLoading ? (
                      <>
                        <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                        Waiting for Google login...
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4" viewBox="0 0 24 24">
                          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                        Login with Google
                      </>
                    )}
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    Uses Google Antigravity OAuth to access Claude via Vertex AI. Opens Google sign-in in your browser.
                  </p>
                </div>
              )}
              {oauthError && (
                <p className="text-xs text-destructive">{oauthError}</p>
              )}
            </div>
          ) : (
          <div className="space-y-2">
            <Label htmlFor="provider-api-key" className="text-xs text-muted-foreground">
              API Key{supportsSubscription && " (Optional)"}
            </Label>
            <Input
              id="provider-api-key"
              type="password"
              placeholder={isMaskedKey ? "Leave empty to keep current key" : supportsSubscription ? "Optional — subscription users can leave blank" : "sk-ant-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
            />
            {supportsSubscription && (
              <p className="text-[11px] text-muted-foreground">
                Subscription users (Pro/Max/Team): leave blank and use <code className="text-[10px] bg-muted px-1 rounded">claude login</code> to authenticate via OAuth.
              </p>
            )}
          </div>
          )}

          {/* Advanced options toggle */}
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <HugeiconsIcon
              icon={showAdvanced ? ArrowUp01Icon : ArrowDown01Icon}
              className="h-3 w-3"
            />
            Advanced Options
          </button>

          {showAdvanced && (
            <div className="space-y-4 border-t border-border/50 pt-4">
              <div className="space-y-2">
                <Label htmlFor="provider-extra-env" className="text-xs text-muted-foreground">
                  Extra Environment Variables (JSON)
                </Label>
                <Textarea
                  id="provider-extra-env"
                  placeholder='{"KEY": "value"}'
                  value={extraEnv}
                  onChange={(e) => setExtraEnv(e.target.value)}
                  className="font-mono text-sm min-h-[80px]"
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider-notes" className="text-xs text-muted-foreground">
                  Notes
                </Label>
                <Textarea
                  id="provider-notes"
                  placeholder="Optional notes about this provider..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="text-sm"
                  rows={2}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving} className="gap-2">
              {saving && (
                <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
              )}
              {saving ? "Saving..." : mode === "edit" ? "Update" : "Add Provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
