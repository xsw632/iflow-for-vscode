import { useSignal } from "@preact/signals";
import { useCallback, useEffect, useRef } from "preact/hooks";
import type { Conversation, ConversationMode, ModelType, WebviewMessage } from "../../../src/protocol";
import { MODELS } from "../../../src/protocol";
import { postMessage } from "../../hooks/usePostMessage";

const SLASH_COMMANDS = [
  { command: "/", description: "Show all commands" },
  { command: "/new", description: "Start a new conversation" },
  { command: "/clear", description: "Clear current conversation" },
  { command: "/compact", description: "Compress conversation context" },
  { command: "/mode", description: "Change conversation mode" },
  { command: "/think", description: "Toggle thinking mode" },
  { command: "/model", description: "Change model" },
  { command: "/workspace", description: "Switch workspace folder" },
  { command: "/help", description: "Show help" },
];

interface MenuItem {
  label: string;
  description: string;
  value: string;
  action: string;
}

interface SlashMenuProps {
  visible: boolean;
  filter: string;
  conversation: Conversation | null;
  workspaceFolders: Array<{ uri: string; name: string }>;
  isMultiRoot: boolean;
  onClose: () => void;
  onClearInput: () => void;
}

export function SlashMenu({
  visible,
  filter,
  conversation,
  workspaceFolders,
  isMultiRoot,
  onClose,
  onClearInput,
}: SlashMenuProps) {
  const mode = useSignal<"commands" | "models" | "modes" | "workspaces">("commands");
  const selectedIndex = useSignal(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const getMenuItems = useCallback((): MenuItem[] => {
    if (mode.value === "models") {
      const currentModel = conversation?.model ?? "GLM-4.7";
      return [
        { label: "←", description: "Back to commands", value: "back", action: "back" },
        ...(MODELS as readonly string[]).map((m) => ({
          label: m,
          description: m === currentModel ? "✓ Current" : "",
          value: m,
          action: "selectModel",
        })),
      ];
    }
    if (mode.value === "modes") {
      const currentMode = conversation?.mode ?? "default";
      const modes = [
        { value: "default", label: "Chat", desc: "Normal conversation" },
        { value: "yolo", label: "YOLO", desc: "Auto-approve actions" },
        { value: "plan", label: "Plan", desc: "Plan before executing" },
        { value: "smart", label: "Smart", desc: "AI-driven edits" },
      ];
      return [
        { label: "←", description: "Back to commands", value: "back", action: "back" },
        ...modes.map((m) => ({
          label: m.label,
          description: (m.value === currentMode ? "✓ " : "") + m.desc,
          value: m.value,
          action: "selectMode",
        })),
      ];
    }
    if (mode.value === "workspaces") {
      const currentUri = conversation?.workspaceFolderUri;
      return [
        { label: "←", description: "Back to commands", value: "back", action: "back" },
        ...workspaceFolders.map((f) => ({
          label: f.name,
          description: (f.uri === currentUri ? "✓ Current  " : "") + f.uri,
          value: f.uri,
          action: "selectWorkspace",
        })),
      ];
    }
    return SLASH_COMMANDS.filter((c) => {
      if (c.command === "/workspace" && !isMultiRoot) return false;
      return c.command.toLowerCase().includes(filter.toLowerCase());
    }).map((c) => ({
      label: c.command,
      description:
        c.description +
        (c.command === "/mode" || c.command === "/model" || c.command === "/workspace"
          ? "  →"
          : ""),
      value: c.command,
      action: "command",
    }));
  }, [mode.value, conversation, workspaceFolders, isMultiRoot, filter]);

  const items = getMenuItems();

  // Clamp selectedIndex
  if (selectedIndex.value >= items.length) selectedIndex.value = Math.max(0, items.length - 1);

  const executeSelected = useCallback(() => {
    const selected = items[selectedIndex.value];
    if (!selected) return;

    switch (selected.action) {
      case "back":
        mode.value = "commands";
        selectedIndex.value = 0;
        break;
      case "selectModel":
        postMessage({ type: "setModel", model: selected.value as ModelType });
        onClearInput();
        onClose();
        break;
      case "selectMode":
        postMessage({ type: "setMode", mode: selected.value as ConversationMode });
        onClearInput();
        onClose();
        break;
      case "selectWorkspace":
        postMessage({ type: "setWorkspaceFolder", uri: selected.value });
        onClearInput();
        onClose();
        break;
      case "command":
        executeCommand(selected.value);
        break;
    }
  }, [items, selectedIndex.value, onClose, onClearInput]);

  const executeCommand = useCallback(
    (command: string) => {
      switch (command) {
        case "/new":
          postMessage({ type: "newConversation" });
          break;
        case "/clear":
          postMessage({ type: "clearConversation" });
          break;
        case "/compact":
          postMessage({ type: "sendMessage", content: "/compact", attachedFiles: [] });
          break;
        case "/mode":
          mode.value = "modes";
          selectedIndex.value = 0;
          return; // don't close
        case "/think": {
          postMessage({ type: "setThink", enabled: !(conversation?.think ?? false) });
          break;
        }
        case "/model":
          mode.value = "models";
          selectedIndex.value = 0;
          return; // don't close
        case "/workspace":
          if (isMultiRoot) {
            mode.value = "workspaces";
            selectedIndex.value = 0;
            return; // don't close
          }
          break;
        case "/help":
          break;
      }
      onClearInput();
      onClose();
    },
    [conversation, isMultiRoot, onClose, onClearInput],
  );

  // Reset mode when menu opens
  useEffect(() => {
    if (visible) {
      mode.value = "commands";
      selectedIndex.value = 0;
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <div class="slash-menu" id="slash-menu" ref={menuRef}>
      {items.map((item, i) => (
        <div
          key={`${item.action}-${item.value}`}
          class={`slash-item ${i === selectedIndex.value ? "selected" : ""}`}
          onClick={() => {
            selectedIndex.value = i;
            executeSelected();
          }}
          onMouseEnter={() => {
            selectedIndex.value = i;
          }}
        >
          <span class="command">{item.label}</span>
          <span class="description">{item.description}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Keyboard handler — call from Composer's onKeyDown.
 * Returns true if the key was consumed.
 */
export function handleSlashMenuKeyDown(
  e: KeyboardEvent,
  visible: boolean,
  selectedIndex: { value: number },
  mode: { value: string },
  itemCount: number,
  executeSelected: () => void,
  onClose: () => void,
  onClearInput: () => void,
): boolean {
  if (!visible) return false;

  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    if (e.key === "ArrowUp") {
      selectedIndex.value = (selectedIndex.value - 1 + itemCount) % itemCount;
    } else {
      selectedIndex.value = (selectedIndex.value + 1) % itemCount;
    }
    return true;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    executeSelected();
    return true;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    if (mode.value !== "commands") {
      mode.value = "commands";
      selectedIndex.value = 0;
    } else {
      onClearInput();
      onClose();
    }
    return true;
  }

  return false;
}
