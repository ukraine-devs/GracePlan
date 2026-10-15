// Records observable application operations, never model reasoning.
export function createExecutionLog(onChange = () => {}, clock = Date.now) {
  const entries = new Map();
  return {
    stage(id, label, status = "running") {
      const now = clock();
      const prior = entries.get(id);
      const entry = { id, label, status, startedAt: prior?.startedAt ?? now };
      if (status !== "running") entry.completedAt = now;
      entries.set(id, entry);
      onChange([...entries.values()]);
    },
    snapshot() {
      return [...entries.values()].map((entry) => ({ ...entry,
        detail: new Date(entry.startedAt).toISOString() + (entry.completedAt ? " → " + new Date(entry.completedAt).toISOString() : "")
      }));
    }
  };
}
