interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
}

/** Inline load-failure state (UI Standards §14.5): message plus a Retry action, not a blank panel. */
function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  return (
    <div
      data-testid="error-banner"
      role="alert"
      className="qiq-banner qiq-banner--error"
      style={{ alignItems: 'center', justifyContent: 'space-between' }}
    >
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="qiq-btn qiq-btn--sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export default ErrorBanner;
