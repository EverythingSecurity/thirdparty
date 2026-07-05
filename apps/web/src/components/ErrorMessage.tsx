import { ApiError } from '../lib/api';

interface Props {
  error: unknown;
}

/**
 * Renders a friendly, non-leaky error. `ApiError` carries the code + message
 * from the server's standard envelope; anything else is shown as a generic
 * failure line (we deliberately do NOT surface stack traces in prod builds).
 */
export function ErrorMessage({ error }: Props) {
  if (!error) return null;
  if (error instanceof ApiError) {
    return (
      <div
        role="alert"
        className="rounded-md border border-red-200 bg-red-50 text-red-900 px-3 py-2 text-sm"
      >
        <div className="font-medium">{error.message}</div>
        {error.fields && (
          <ul className="mt-1 list-disc list-inside text-xs">
            {Object.entries(error.fields).map(([field, msg]) => (
              <li key={field}>
                <span className="font-mono">{field}</span>: {msg}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 text-red-900 px-3 py-2 text-sm"
    >
      Something went wrong.
    </div>
  );
}
