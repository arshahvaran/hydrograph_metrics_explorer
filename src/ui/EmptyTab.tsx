export function EmptyTab({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{text}</p>
      <p className="muted">This build is a development checkpoint published while the tool is assembled; the engine underneath is tested at every step (see the repository for the test suite and roadmap).</p>
    </div>
  );
}
