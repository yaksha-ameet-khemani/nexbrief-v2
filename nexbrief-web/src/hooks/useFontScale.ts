import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "nexbrief_font_scale_step";
const STEP_SIZE = 0.1; // 10% per A+/A- click
const MIN_STEP = -2;
const MAX_STEP = 2;

function clamp(step: number): number {
  return Math.min(MAX_STEP, Math.max(MIN_STEP, step));
}

function loadStep(): number {
  const saved = parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10);
  return Number.isFinite(saved) ? clamp(saved) : 0;
}

// Drives the --font-scale CSS variable on <html> (see index.css), which
// multiplies the app's base rem size — so every Tailwind text-* class scales
// together instead of needing per-component font-size logic. Persisted so a
// reader's chosen size survives a reload.
export function useFontScale() {
  const [step, setStep] = useState(loadStep);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-scale", String(1 + step * STEP_SIZE));
    localStorage.setItem(STORAGE_KEY, String(step));
  }, [step]);

  const increase = useCallback(() => setStep((s) => clamp(s + 1)), []);
  const decrease = useCallback(() => setStep((s) => clamp(s - 1)), []);

  return {
    increase,
    decrease,
    canIncrease: step < MAX_STEP,
    canDecrease: step > MIN_STEP,
  };
}
