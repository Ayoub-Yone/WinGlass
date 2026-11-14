// Gmail unread + today delta; X, YouTube and Instagram follower / subscriber counters.

import { BrandGlyph, ProviderState, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { formatCount, formatSigned } from "../lib/format";
import { ipc } from "../lib/ipc";
import { usePreview, useProvider } from "../lib/hooks";
import type { GmailData, ProviderId, SocialData, WidgetProps } from "../types/lumabar";

export function GmailWidget({ span }: WidgetProps) {
  const { t } = useI18n();
  const view = useProvider<GmailData>("gmail");
  const preview = usePreview();
  const glyph = <BrandGlyph id="gmail" size={22} />;
  if (!view.data) return <ProviderState span={span} providerId="gmail" glyph={glyph} name="Gmail" status={view.status} error={view.error} />;
  const d = view.data;
  return (
    <WidgetCard span={span} title={view.error ?? d.account} onClick={() => !preview && void ipc.openTarget("https://mail.google.com/mail/u/0/#inbox")}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative shrink-0">
          {glyph}
          {d.unread > 0 && span === "1x1" && (
            <span
              className="absolute -right-1.5 -top-1.5 min-w-[15px] rounded-full px-1 text-center font-bold text-white"
              style={{ background: "var(--lb-red)", fontSize: 9, lineHeight: "15px" }}
            >
              {d.unread > 99 ? "99+" : d.unread}
            </span>
          )}
        </div>
        {span !== "1x1" ? (
          <div className="min-w-0 leading-tight">
            <div className="truncate font-semibold">
              <span className="tabular-nums">{formatCount(d.unread)}</span> {t("gmail.unread")}
            </div>
            <div className="truncate lb-muted tabular-nums" style={{ fontSize: "var(--lb-small)" }}>
              {t("social.today", { delta: formatSigned(d.today) })}
            </div>
          </div>
        ) : (
          <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
            {formatCount(d.unread)}
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

function SocialWidget(props: WidgetProps & { providerId: ProviderId; name: string; url: (d: SocialData) => string }) {
  const { span, providerId, name, url } = props;
  const { t } = useI18n();
  const view = useProvider<SocialData>(providerId);
  const preview = usePreview();
  const glyph = <BrandGlyph id={providerId} size={22} />;
  if (!view.data) return <ProviderState span={span} providerId={providerId} glyph={glyph} name={name} status={view.status} error={view.error} />;
  const d = view.data;
  return (
    <WidgetCard span={span} title={view.error ?? d.handle} onClick={() => !preview && void ipc.openTarget(url(d))}>
      <div className="flex min-w-0 items-center gap-2">
        {glyph}
        <div className="min-w-0 leading-tight">
          <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
            {formatCount(d.followers)}
          </div>
          <div className="truncate" style={{ fontSize: "var(--lb-small)" }}>
            {span === "1x1" ? (
              <span style={{ color: d.deltaToday >= 0 ? "var(--lb-green)" : "var(--lb-red)" }}>{formatSigned(d.deltaToday)}</span>
            ) : (
              <>
                <span className="lb-muted">{d.metric === "subscribers" ? t("social.subscribers") : t("social.followers")} · </span>
                <span style={{ color: d.deltaToday >= 0 ? "var(--lb-green)" : "var(--lb-red)" }}>{t("social.today", { delta: formatSigned(d.deltaToday) })}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </WidgetCard>
  );
}

export const XWidget = (p: WidgetProps) => (
  <SocialWidget {...p} providerId="x" name="X" url={(d) => `https://x.com/${d.handle.replace(/^@/, "")}`} />
);
export const YouTubeWidget = (p: WidgetProps) => (
  <SocialWidget {...p} providerId="youtube" name="YouTube" url={() => "https://studio.youtube.com"} />
);
export const InstagramWidget = (p: WidgetProps) => (
  <SocialWidget {...p} providerId="instagram" name="Instagram" url={(d) => `https://www.instagram.com/${d.handle.replace(/^@/, "")}`} />
);
