import { TopBar } from "./topbar/TopBar";
import { MessageList } from "./chat/MessageList";
import { Composer } from "./composer/Composer";

interface AppProps {
  faviconUri: string;
}

export function App({ faviconUri }: AppProps) {
  return (
    <div class="container">
      <TopBar />
      <MessageList faviconUri={faviconUri} />
      <Composer />
    </div>
  );
}
