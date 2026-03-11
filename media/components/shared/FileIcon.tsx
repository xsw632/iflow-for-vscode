import { getFileIcon, getFileIconClass } from "../../fileUtils";

export function FileIcon({
  path,
  extraClass = "",
}: {
  path: string;
  extraClass?: string;
}) {
  const classes = ["file-icon", getFileIconClass(path)];
  if (extraClass) classes.push(extraClass);
  return (
    <span class={classes.join(" ")} aria-hidden="true">
      {getFileIcon(path)}
    </span>
  );
}
