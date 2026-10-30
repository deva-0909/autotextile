import { useState } from 'react';
import { ApiError } from '../lib/api';

/** Minimal form state with server-side field errors (422/400 details.fields). */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = <K extends keyof T>(key: K, value: T[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key as string]) setErrors((e) => { const n = { ...e }; delete n[key as string]; return n; });
  };

  /** Props for a text-like input bound to `key`. */
  const bind = (key: keyof T & string) => ({
    value: (values[key] ?? '') as string | number,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as T[typeof key]),
    error: errors[key],
    name: key,
  });

  function handleError(err: unknown) {
    if (err instanceof ApiError) {
      setErrors(err.fields);
      setFormError(Object.keys(err.fields).length ? null : err.message);
      if (Object.keys(err.fields).length && !Object.values(err.fields).includes(err.message)) setFormError(err.message === 'Some fields need attention' ? null : err.message);
    } else setFormError((err as Error).message);
  }

  return { values, setValues, set, bind, errors, setErrors, formError, setFormError, handleError, reset: () => { setValues(initial); setErrors({}); setFormError(null); } };
}

/** Converts '' to null and numeric strings to numbers for the listed keys. */
export function clean<T extends Record<string, unknown>>(v: T, numeric: (keyof T)[] = []) {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (numeric.includes(k as keyof T)) out[k] = val === '' || val === null || val === undefined ? null : Number(val);
    else out[k] = val === '' ? null : val;
  }
  return out;
}
