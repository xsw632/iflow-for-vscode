export function WarningBlock({ message }: { message: string }) {
  return (
    <div class="block-warning">
      <span class="icon">⚠</span>
      <span>{message}</span>
    </div>
  );
}
