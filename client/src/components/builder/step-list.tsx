// Left pane: the ordered steps. Drag to reorder, or Alt+↑/↓ on a focused step.
import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import { ACTIONS, describeLocator, stepSchema, type Step } from "@shared/steps";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { StepStatus } from "@/lib/types";

export function stepProblems(step: Step): string[] {
  const r = stepSchema.safeParse(step);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

const RESULT_DOT: Record<StepStatus, string> = {
  passed: "bg-success",
  failed: "bg-danger",
  warning: "bg-warning",
  skipped: "bg-border-strong",
};

export function StepList({
  steps,
  selected,
  onSelect,
  onMove,
  onAdd,
  onDuplicate,
  onRemove,
  readOnly,
  lastResults,
}: {
  steps: Step[];
  selected: number;
  onSelect: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onAdd: (after: number) => void;
  onDuplicate: (i: number) => void;
  onRemove: (i: number) => void;
  readOnly: boolean;
  lastResults?: Map<number, StepStatus>;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <span className="text-[13px] font-medium">
          Steps <span className="tabular font-normal text-subtle">{steps.length}</span>
        </span>
        {!readOnly && (
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onAdd(selected)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="Steps">
        {steps.map((s, i) => {
          const problems = stepProblems(s);
          const result = lastResults?.get(i + 1);
          return (
            <li
              key={i}
              draggable={!readOnly}
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragging === null) return;
                e.preventDefault();
                setOver(i);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== i) onMove(dragging, i);
                setDragging(null);
                setOver(null);
              }}
              className={cn("relative", over === i && dragging !== null && dragging !== i && (dragging < i ? "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded after:bg-brand" : "before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded before:bg-brand"))}
            >
              <div
                role="button"
                tabIndex={0}
                aria-current={selected === i ? "step" : undefined}
                onClick={() => onSelect(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(i);
                  } else if (!readOnly && e.altKey && e.key === "ArrowUp" && i > 0) {
                    e.preventDefault();
                    onMove(i, i - 1);
                  } else if (!readOnly && e.altKey && e.key === "ArrowDown" && i < steps.length - 1) {
                    e.preventDefault();
                    onMove(i, i + 1);
                  } else if (e.key === "ArrowDown" && i < steps.length - 1) {
                    e.preventDefault();
                    onSelect(i + 1);
                    (e.currentTarget.parentElement?.nextElementSibling?.firstElementChild as HTMLElement | null)?.focus();
                  } else if (e.key === "ArrowUp" && i > 0) {
                    e.preventDefault();
                    onSelect(i - 1);
                    (e.currentTarget.parentElement?.previousElementSibling?.firstElementChild as HTMLElement | null)?.focus();
                  }
                }}
                className={cn(
                  "group flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                  selected === i ? "bg-brand/[0.08] ring-1 ring-brand/30" : "hover:bg-muted/60",
                  !s.enabled && "opacity-55",
                  dragging === i && "opacity-40",
                )}
              >
                <span className="mt-0.5 flex w-6 shrink-0 flex-col items-center gap-1">
                  <span className="tabular text-[11px] text-subtle">{i + 1}</span>
                  {!readOnly && <GripVertical className="h-3.5 w-3.5 cursor-grab text-border-strong opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{s.name || <span className="text-subtle">Untitled step</span>}</span>
                    {problems.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-label={`Needs attention: ${problems[0]}`} />
                        </TooltipTrigger>
                        <TooltipContent>{problems[0]}</TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                    <span className="text-foreground/70">{ACTIONS[s.action]?.label ?? s.action}</span>
                    {describeLocator(s) && <> · <code className="text-[11px]">{describeLocator(s)}</code></>}
                    {s.value && !describeLocator(s) && <> · {s.value.length > 40 ? s.value.slice(0, 40) + "…" : s.value}</>}
                    {s.options?.continueOnFailure && <> · soft</>}
                    {!s.enabled && <> · off</>}
                  </span>
                </span>
                {result && <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", RESULT_DOT[result])} aria-label={`Last run: ${result}`} />}
                {!readOnly && selected === i && (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button aria-label="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); onMove(i, i - 1); }} className="rounded p-0.5 text-subtle hover:bg-muted hover:text-foreground disabled:opacity-30">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button aria-label="Move down" disabled={i === steps.length - 1} onClick={(e) => { e.stopPropagation(); onMove(i, i + 1); }} className="rounded p-0.5 text-subtle hover:bg-muted hover:text-foreground disabled:opacity-30">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button aria-label="Duplicate step" onClick={(e) => { e.stopPropagation(); onDuplicate(i); }} className="rounded p-0.5 text-subtle hover:bg-muted hover:text-foreground">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button aria-label="Delete step" onClick={(e) => { e.stopPropagation(); onRemove(i); }} className="rounded p-0.5 text-subtle hover:bg-danger-soft hover:text-danger">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </div>
            </li>
          );
        })}
        {!steps.length && <li className="px-3 py-8 text-center text-sm text-muted-foreground">No steps yet.{!readOnly && " Add the first one."}</li>}
      </ol>
    </div>
  );
}
