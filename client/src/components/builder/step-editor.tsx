// Middle pane: the selected step's details.
import { useMemo } from "react";
import { KeyRound, Lightbulb } from "lucide-react";
import { ACTIONS, ACTION_NAMES, LOCATOR_LABELS, LOCATOR_TYPES, stepSchema, type Action, type ActionSpec, type LocatorType, type Step } from "@shared/steps";
import { cn } from "@/lib/utils";
import type { Secret } from "@/lib/types";
import { Field, Notice } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const GROUPS = ["Navigation", "Interaction", "Waits", "Assertions", "Evidence", "Advanced"] as const;

const LOCATOR_HINT: Record<LocatorType, string> = {
  role: "Most robust. An ARIA role (button, link, textbox, checkbox, dialog…) plus the accessible name below.",
  label: "The text of the field's <label>.",
  text: "Visible text. Partial, case-insensitive match unless “Exact match” is on.",
  placeholder: "The field's placeholder text.",
  test_id: "A data-testid attribute added for tests. Very stable when available.",
  css: "A CSS selector. Prefer roles, labels or test IDs; CSS breaks when styling changes.",
  xpath: "Last resort. XPath is the most fragile choice.",
  id: "The element's id attribute, without the #.",
};

function issuesFor(step: Step) {
  const r = stepSchema.safeParse(step);
  const map = new Map<string, string>();
  if (!r.success) for (const i of r.error.issues) map.set(String(i.path[0] ?? "_"), i.message);
  return map;
}

export function StepEditor({ step, index, onChange, readOnly, secrets, scriptStepsAllowed }: { step: Step; index: number; onChange: (s: Step) => void; readOnly: boolean; secrets: Secret[]; scriptStepsAllowed: boolean }) {
  const spec: ActionSpec = ACTIONS[step.action];
  const issues = useMemo(() => issuesFor(step), [step]);
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch });
  const setOpt = (patch: Partial<Step["options"]>) => {
    const next = { ...step.options, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined || next[k] === "" || next[k] === false) delete next[k];
    onChange({ ...step, options: next });
  };
  const changeAction = (a: Action) => {
    const nextSpec = ACTIONS[a];
    onChange({
      ...step,
      action: a,
      name: !step.name || step.name === spec.label ? nextSpec.label : step.name,
      locatorType: nextSpec.locator === "none" ? null : (step.locatorType ?? "role"),
      locatorValue: nextSpec.locator === "none" ? null : step.locatorValue,
      value: nextSpec.value ? step.value : null,
    });
  };

  return (
    <fieldset disabled={readOnly} className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="eyebrow">Step {index + 1}</div>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Switch checked={step.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Step is on" />
          {step.enabled ? "On" : "Off (skipped)"}
        </label>
      </div>

      <Field label="Name" htmlFor="step-name" error={issues.get("name")}>
        <Input id="step-name" value={step.name} onChange={(e) => set({ name: e.target.value })} placeholder="What this step does" />
      </Field>

      <Field label="Action" hint={spec.description}>
        <Select value={step.action} onValueChange={(v) => changeAction(v as Action)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-[360px]">
            {GROUPS.map((g) => (
              <SelectGroup key={g}>
                <SelectLabel className="text-xs text-muted-foreground">{g}</SelectLabel>
                {ACTION_NAMES.filter((a) => ACTIONS[a].group === g && (a !== "script" || scriptStepsAllowed || step.action === "script")).map((a) => (
                  <SelectItem key={a} value={a}>
                    {ACTIONS[a].label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {step.action === "script" && !scriptStepsAllowed && <Notice tone="warning">Script steps are disabled on this server, so this step can't be published while it's on. Replace it with a regular step.</Notice>}

      {spec.locator !== "none" && (
        <div className="space-y-3 rounded-lg border bg-surface-2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium">Element {spec.locator === "optional" && <span className="font-normal text-subtle">optional</span>}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
            <Select value={step.locatorType ?? ""} onValueChange={(v) => set({ locatorType: v as LocatorType })}>
              <SelectTrigger aria-label="Find the element by">
                <SelectValue placeholder="Find by…" />
              </SelectTrigger>
              <SelectContent>
                {LOCATOR_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {LOCATOR_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={step.locatorValue ?? ""}
              onChange={(e) => set({ locatorValue: e.target.value })}
              placeholder={step.locatorType === "role" ? "button" : step.locatorType === "css" ? "form .submit" : "Sign in"}
              className={cn("font-mono text-[13px]", issues.get("locatorValue") && "border-danger")}
              aria-label="Element"
              aria-invalid={!!issues.get("locatorValue")}
            />
          </div>
          {issues.get("locatorValue") ? <p className="text-xs text-danger">{issues.get("locatorValue")}</p> : step.locatorType && <p className="text-xs text-muted-foreground">{LOCATOR_HINT[step.locatorType]}</p>}
          {step.locatorType === "role" && (
            <Field label="Accessible name" htmlFor="role-name" hint="The button's text or the field's label, e.g. “Sign in”.">
              <Input id="role-name" value={step.options.roleName ?? ""} onChange={(e) => setOpt({ roleName: e.target.value })} />
            </Field>
          )}
          {step.locatorType && ["css", "xpath"].includes(step.locatorType) && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              If the element has visible text, a label or a role, those survive redesigns better than {step.locatorType === "css" ? "CSS" : "XPath"}.
            </p>
          )}
        </div>
      )}

      {spec.value && (
        <Field label={spec.value.label} htmlFor="step-value" error={issues.get("value")}>
          <div className="flex gap-2">
            {step.action === "script" ? (
              <Textarea id="step-value" rows={5} className="font-mono text-[13px]" value={step.value ?? ""} onChange={(e) => set({ value: e.target.value })} />
            ) : (
              <Input id="step-value" value={step.value ?? ""} onChange={(e) => set({ value: e.target.value })} placeholder={spec.value.placeholder} className={cn(step.value?.includes("{{") && "font-mono text-[13px]")} />
            )}
            {spec.value.secretOk && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="Insert a secret">
                    <KeyRound className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Insert a workspace secret. Its value is only read by the runner.</DropdownMenuLabel>
                  {secrets.length ? (
                    secrets.map((s) => (
                      <DropdownMenuItem key={s.id} onSelect={() => set({ value: `{{secrets.${s.name}}}` })}>
                        <code className="text-xs">{s.name}</code>
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No secrets yet. Admins add them in Settings → Secrets.</div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </Field>
      )}

      <details className="group rounded-lg border bg-surface-2 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-[13px] font-medium">
          Options
          <span className="text-xs font-normal text-muted-foreground">
            {[step.options.timeoutMs && `${step.options.timeoutMs / 1000}s timeout`, step.options.continueOnFailure && "soft", step.options.opensNewTab && "new tab", step.options.frame && "frame"].filter(Boolean).join(" · ") || "Defaults"}
          </span>
        </summary>
        <div className="grid gap-4 border-t px-4 py-4 sm:grid-cols-2">
          <Field label="Timeout (seconds)" htmlFor="opt-timeout" hint="Blank uses the test's step timeout.">
            <Input id="opt-timeout" type="number" inputMode="numeric" min={0.1} max={600} step="any" value={step.options.timeoutMs ? step.options.timeoutMs / 1000 : ""} onChange={(e) => setOpt({ timeoutMs: e.target.value ? Math.round(Number(e.target.value) * 1000) : undefined })} />
          </Field>
          {spec.locator !== "none" && (
            <Field label="Inside frame" htmlFor="opt-frame" hint="CSS selector of an iframe. Blank searches every frame.">
              <Input id="opt-frame" className="font-mono text-[13px]" value={step.options.frame ?? ""} onChange={(e) => setOpt({ frame: e.target.value || undefined })} placeholder='iframe[title="Chat"]' />
            </Field>
          )}
          {spec.locator !== "none" && (
            <Field label="Which match" htmlFor="opt-nth" hint="Blank uses the first match. 0 is the first.">
              <Input id="opt-nth" type="number" inputMode="numeric" min={0} value={step.options.nth ?? ""} onChange={(e) => setOpt({ nth: e.target.value === "" ? undefined : Number(e.target.value) })} />
            </Field>
          )}
          <div className="space-y-3 sm:col-span-2">
            {[
              { key: "continueOnFailure" as const, label: "Continue on failure", hint: "Record a warning instead of failing the test.", show: step.action !== "screenshot" },
              { key: "exact" as const, label: "Exact match", hint: "Match the whole text, case-sensitive.", show: ["text", "label", "placeholder", "role"].includes(step.locatorType ?? "") },
              { key: "opensNewTab" as const, label: "Opens a new tab", hint: "Continue the test in the tab this click opens.", show: step.action === "click" },
              { key: "typeSlowly" as const, label: "Type slowly", hint: "Press each key, for fields that react to typing.", show: step.action === "fill" },
              { key: "force" as const, label: "Skip visibility checks", hint: "Click even if something covers the element. Use sparingly.", show: ["click", "check", "uncheck"].includes(step.action) },
            ]
              .filter((o) => o.show)
              .map((o) => (
                <label key={o.key} className="flex items-start gap-3">
                  <Switch className="mt-0.5" checked={!!step.options[o.key]} onCheckedChange={(v) => setOpt({ [o.key]: v || undefined })} />
                  <span>
                    <span className="block text-[13px] font-medium">{o.label}</span>
                    <span className="block text-xs text-muted-foreground">{o.hint}</span>
                  </span>
                </label>
              ))}
          </div>
        </div>
      </details>
    </fieldset>
  );
}
