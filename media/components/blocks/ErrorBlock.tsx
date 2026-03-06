export function ErrorBlock({ message }: { message: string }) {
  return (
    <div class="block-error">
      <span class="icon">❌</span>
      <span>{message}</span>
    </div>
  );
}
