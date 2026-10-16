// The step model shared by the API, the runner and the builder UI.
import { z } from "zod";

export const LOCATOR_TYPES = ["role", "label", "text", "placeholder", "test_id", "css", "xpath", "id"] as const;
export type LocatorType = (typeof LOCATOR_TYPES)[number];

export const LOCATOR_LABELS: Record<LocatorType, string> = {
  role: "Role (accessible role + name)",
  label: "Label",
  text: "Visible text",
  placeholder: "Placeholder",
  test_id: "Test ID (data-testid)",
  css: "CSS selector",
  xpath: "XPath",
  id: "Element ID",
};

export type ActionSpec = {
  label: string;
  group: "Navigation" | "Interaction" | "Waits" | "Assertions" | "Evidence" | "Advanced";
  locator: "required" | "optional" | "none";
  value: { label: string; required: boolean; placeholder?: string; secretOk?: boolean } | null;
  description: string;
};

export const ACTIONS = {
  navigate: { label: "Go to URL", group: "Navigation", locator: "none", value: { label: "URL or path", required: true, placeholder: "/login or https://…" }, description: "Open a URL. Paths are resolved against the environment's base URL." },
  refresh: { label: "Reload page", group: "Navigation", locator: "none", value: null, description: "Reload the current page." },
  switch_to_new_tab: { label: "Switch to newest tab", group: "Navigation", locator: "none", value: null, description: "Continue in the most recently opened tab." },
  switch_to_main_tab: { label: "Switch to first tab", group: "Navigation", locator: "none", value: null, description: "Return to the tab the test started in." },
  click: { label: "Click", group: "Interaction", locator: "required", value: null, description: "Click an element. Turn on “Opens a new tab” to continue in the tab it opens." },
  fill: { label: "Fill field", group: "Interaction", locator: "required", value: { label: "Text", required: false, placeholder: "Text, or {{secrets.NAME}}", secretOk: true }, description: "Replace a field's contents." },
  clear: { label: "Clear field", group: "Interaction", locator: "required", value: null, description: "Empty a field." },
  select: { label: "Select option", group: "Interaction", locator: "required", value: { label: "Option label or value", required: true }, description: "Choose an option in a <select>." },
  check: { label: "Check", group: "Interaction", locator: "required", value: null, description: "Tick a checkbox or radio button." },
  uncheck: { label: "Uncheck", group: "Interaction", locator: "required", value: null, description: "Untick a checkbox." },
  hover: { label: "Hover", group: "Interaction", locator: "required", value: null, description: "Move the pointer over an element." },
  press: { label: "Press key", group: "Interaction", locator: "optional", value: { label: "Key", required: true, placeholder: "Enter, Tab, Control+A…" }, description: "Press a key, on an element or the page." },
  scroll: { label: "Scroll", group: "Interaction", locator: "optional", value: null, description: "Scroll an element into view, or to the bottom of the page." },
  wait: { label: "Pause", group: "Waits", locator: "none", value: { label: "Seconds", required: true, placeholder: "2" }, description: "Wait a fixed time. Prefer waiting for text or an element." },
  wait_for_text: { label: "Wait for text", group: "Waits", locator: "optional", value: { label: "Text", required: true }, description: "Wait until text appears (in the page, any frame, or inside the element)." },
  wait_for_text_gone: { label: "Wait for text to disappear", group: "Waits", locator: "optional", value: { label: "Text", required: true }, description: "Wait until text is no longer shown." },
  wait_for_element: { label: "Wait for element", group: "Waits", locator: "required", value: null, description: "Wait until an element is visible." },
  wait_for_element_gone: { label: "Wait for element to disappear", group: "Waits", locator: "required", value: null, description: "Wait until an element is hidden or removed." },
  assert_text: { label: "Check text is shown", group: "Assertions", locator: "optional", value: { label: "Expected text", required: true }, description: "Fail unless the text is shown." },
  assert_url: { label: "Check URL contains", group: "Assertions", locator: "none", value: { label: "Expected fragment", required: true, placeholder: "/dashboard" }, description: "Fail unless the current URL contains the value." },
  assert_value: { label: "Check field value", group: "Assertions", locator: "required", value: { label: "Expected value", required: true }, description: "Fail unless the field's value contains the text." },
  assert_visible: { label: "Check element is visible", group: "Assertions", locator: "required", value: null, description: "Fail unless the element is visible." },
  assert_hidden: { label: "Check element is hidden", group: "Assertions", locator: "required", value: null, description: "Fail unless the element is hidden or absent." },
  screenshot: { label: "Screenshot", group: "Evidence", locator: "none", value: null, description: "Save a full-page screenshot to the run." },
  script: { label: "Run script (private runners only)", group: "Advanced", locator: "none", value: { label: "JavaScript", required: true }, description: "Runs JavaScript in the page. Disabled unless the runner sets ALLOW_SCRIPT_STEPS." },
} as const satisfies Record<string, ActionSpec>;

export type Action = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as Action[];

export const stepOptionsSchema = z
  .object({
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
    // A soft check: a failure is recorded as a warning and the run continues.
    continueOnFailure: z.boolean().optional(),
    opensNewTab: z.boolean().optional(),
    roleName: z.string().max(500).optional(),
    exact: z.boolean().optional(),
    // CSS selector of an iframe to work inside.
    frame: z.string().max(500).optional(),
    nth: z.number().int().min(0).max(1000).optional(),
    typeSlowly: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();
export type StepOptions = z.infer<typeof stepOptionsSchema>;

const stepFields = z.object({
  name: z.string().trim().min(1, "Give the step a name").max(200),
  action: z.enum(ACTION_NAMES as [Action, ...Action[]]),
  locatorType: z.enum(LOCATOR_TYPES).nullable().optional(),
  locatorValue: z.string().max(2000).nullable().optional(),
  value: z.string().max(10_000).nullable().optional(),
  options: stepOptionsSchema.default({}),
  enabled: z.boolean().default(true),
});

/** Drafts may be incomplete (a click without its element yet); only the shape is checked. */
export const draftStepSchema = stepFields.extend({ name: z.string().max(200) });
export const draftStepsSchema = z.array(draftStepSchema).max(500);

/** A step that can be published and run. */
export const stepSchema = stepFields
  .superRefine((step, ctx) => {
    const spec: ActionSpec = ACTIONS[step.action];
    const hasLocator = !!(step.locatorType && step.locatorValue && step.locatorValue.trim());
    if (spec.locator === "required" && !hasLocator) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["locatorValue"], message: "This action needs an element to act on" });
    }
    if (spec.locator === "none" && hasLocator) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["locatorType"], message: "This action does not use an element" });
    }
    if (step.locatorType === "role" && hasLocator && !/^[a-z]+$/.test(step.locatorValue!.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["locatorValue"], message: "Use an ARIA role such as button, link or textbox" });
    }
    if (spec.value?.required && !(step.value && step.value.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${spec.value.label} is required` });
    }
    if (step.action === "wait" && step.value && !/^\d+(\.\d+)?$/.test(step.value.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Seconds must be a number" });
    }
    if (step.value && /\{\{\s*secrets\./.test(step.value) && !spec.value?.secretOk) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Secrets can only be used in fill steps" });
    }
  });
export type Step = z.infer<typeof stepSchema>;

export const stepsSchema = z.array(stepSchema).max(500);

export const SECRET_REF = /\{\{\s*secrets\.([A-Z][A-Z0-9_]{0,63})\s*\}\}/g;
export function secretNames(steps: Pick<Step, "value">[]): string[] {
  const names = new Set<string>();
  for (const s of steps) for (const m of (s.value ?? "").matchAll(SECRET_REF)) names.add(m[1]);
  return [...names];
}

/** A test_steps row (the draft) as a Step. */
export function rowToStep(row: {
  stepName: string;
  action: string;
  locatorType: string | null;
  locatorValue: string | null;
  inputValue: string | null;
  options: unknown;
  enabled: boolean;
}): Step {
  return {
    name: row.stepName,
    action: row.action as Action,
    locatorType: (row.locatorType as LocatorType) ?? null,
    locatorValue: row.locatorValue,
    value: row.inputValue,
    options: (row.options as StepOptions) ?? {},
    enabled: row.enabled,
  };
}

export function describeLocator(step: Pick<Step, "locatorType" | "locatorValue" | "options">): string {
  if (!step.locatorType || !step.locatorValue) return "";
  const v = step.locatorValue;
  switch (step.locatorType) {
    case "role":
      return step.options?.roleName ? `${v} “${step.options.roleName}”` : v;
    case "label":
      return `label “${v}”`;
    case "text":
      return `text “${v}”`;
    case "placeholder":
      return `placeholder “${v}”`;
    case "test_id":
      return `[data-testid=${v}]`;
    case "id":
      return `#${v}`;
    default:
      return v;
  }
}
