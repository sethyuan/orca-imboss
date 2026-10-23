import type { SVGProps } from "react";

/**
 * Hand-drawn inline SVG icons (prototype-parity). Stroke-based, `currentColor`.
 * No icon library — these stay in the bundle.
 */

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps): IconProps {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    ...props,
  };
}

export function IconChat(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.35-4.2-1L3 20l1.5-4.3A8.5 8.5 0 1 1 21 11.5Z" />
    </svg>
  );
}

export function IconModels(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 3 3.5 7.5 12 12l8.5-4.5L12 3Z" />
      <path d="M3.5 12 12 16.5 20.5 12" />
      <path d="M3.5 16.5 12 21l8.5-4.5" />
    </svg>
  );
}

export function IconMcp(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} viewBox="0 0 1024 1024" fill="currentColor">
      <path
        d="M446.031676 116.873621L80.115479 482.728143q-2.466989 2.466989-4.317231 5.304027-1.973591 2.898712-3.268761 6.105799-1.356844 3.207086-2.035266 6.599197-0.616747 3.39211-0.616747 6.78422 0 3.51546 0.616747 6.90757 0.678422 3.39211 2.035266 6.599197 1.295169 3.207086 3.268761 6.044124 1.850242 2.898712 4.317231 5.365702 2.466989 2.466989 5.365702 4.317231 2.837038 1.973591 6.044124 3.268761 3.207086 1.356844 6.599197 2.035266 3.39211 0.616747 6.845895 0.616748t6.907571-0.616748q3.39211-0.678422 6.537521-2.035266 3.207086-1.295169 6.105799-3.207086 2.898712-1.911917 5.304027-4.378906L495.741512 166.521782q28.000329-28.062004 67.102111-28.062004 39.101781 0 67.10211 28.062004 28.062004 28.000329 28.062004 67.10211 0 39.101781-28.062004 67.102111L354.012973 576.720438q-2.466989 2.466989-4.317231 5.365702-1.973591 2.837038-3.268761 6.044124-1.356844 3.207086-2.035266 6.599196-0.616747 3.39211-0.616748 6.845896 0 3.51546 0.616748 6.90757 0.678422 3.39211 2.035266 6.599196 1.295169 3.145411 3.207086 6.044124 1.973591 2.898712 4.378906 5.304027 2.466989 2.466989 5.365702 4.378907 2.837038 1.911917 6.044124 3.26876 3.207086 1.295169 6.599197 1.973592t6.845895 0.678422q3.453785 0 6.845896-0.616747 3.39211-0.740097 6.599196-2.035267 3.207086-1.356844 6.105799-3.26876 2.898712-1.850242 5.304027-4.317232l275.994435-275.994435q27.013534-27.075208 68.27393-25.533339 41.938819 1.480194 71.049294 30.652342 27.075208 27.075208 25.595014 63.216603-1.541868 36.758141-30.714017 65.93029l-326.99944 326.99944q-55.507261 55.507261 0 111.076196l61.304686 61.304686q2.466989 2.466989 5.304027 4.378906 2.898712 1.911917 6.105799 3.268761 3.207086 1.295169 6.599196 1.973591t6.784221 0.678422q3.51546 0 6.90757-0.616747 3.39211-0.740097 6.599197-2.035266 3.207086-1.356844 6.044123-3.268761 2.898712-1.911917 5.365702-4.317231 2.466989-2.466989 4.317232-5.365702 1.973591-2.898712 3.268761-6.105799 1.356844-3.207086 2.035266-6.599197 0.616747-3.39211 0.616747-6.78422 0-3.51546-0.616747-6.90757-0.678422-3.39211-2.035266-6.599197-1.295169-3.207086-3.207087-6.044124-1.911917-2.898712-4.378906-5.365702l-61.304685-61.304685q-5.8591-5.797425 0-11.59485l326.99944-327.061115q48.59969-48.59969 51.190029-112.741414 2.775363-66.978761-46.071027-115.82515-48.72304-48.72304-118.16879-51.190029-12.088248-0.493398-23.559748 0.555072 1.233495-10.484705 1.233494-21.586157 0-68.212256-48.538015-116.873621-48.661365-48.59969-116.873621-48.59969-68.212256 0-116.811947 48.661365z m275.93276 275.93276q2.466989-2.466989 5.304028-4.378906 2.898712-1.911917 6.105798-3.268761 3.207086-1.295169 6.599197-1.973592t6.845895-0.678422q3.453785 0 6.845896 0.616748 3.39211 0.740097 6.599196 2.035266 3.207086 1.356844 6.105799 3.268761 2.837038 1.911917 5.304027 4.317231 2.466989 2.466989 4.317231 5.365702 1.973591 2.898712 3.268761 6.105799 1.356844 3.145411 2.035267 6.599196 0.616747 3.39211 0.616747 6.784221 0 3.51546-0.616747 6.90757-0.678422 3.39211-2.035267 6.599197-1.295169 3.207086-3.207086 6.044124-1.911917 2.898712-4.378906 5.365702l-273.897494 273.835819q-48.59969 48.72304-116.873621 48.72304-68.212256 0-116.811946-48.72304-48.59969-48.59969-48.59969-116.811947 0-68.212256 48.59969-116.811946l273.897494-273.835819q2.466989-2.466989 5.304027-4.440581 2.898712-1.850242 6.105799-3.207086 3.207086-1.356844 6.599196-2.035266 3.39211-0.616747 6.845896-0.616747t6.845895 0.616747q3.39211 0.678422 6.599197 2.035266 3.207086 1.295169 6.105798 3.207086 2.837038 1.911917 5.304028 4.378906 2.466989 2.466989 4.317231 5.365702 1.973591 2.837038 3.330436 6.044124 1.295169 3.207086 1.973591 6.599197 0.616747 3.39211 0.616747 6.845895t-0.616747 6.845896q-0.678422 3.39211-1.973591 6.599196-1.356844 3.207086-3.268761 6.105799-1.911917 2.837038-4.378906 5.304027l-273.83582 273.835819q-28.062004 28.062004-28.062004 67.22546 0 39.040107 28.00033 67.102111 28.062004 28.000329 67.10211 28.000329 39.101781 0 67.163786-28.000329l273.835819-273.897494h0.061674z"
        p-id="1696"
      ></path>
    </svg>
  );
}

export function IconSkills(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} viewBox="0 0 1024 1024" fill="currentColor">
      <path
        d="M918 787.978L535.4 923.26l-9.98 4.74h-30.84l-9.98-4.74L102 787.978 78 754.03V231.948L126 198l40 14.144V134.57L217.42 102 510 240.85 802.58 102 854 134.57v77.574L894 198l48 33.948V754.03zM150 282.866V728.57l16 5.658V288.524z m324 20.67l-236-112v534.93l236 112v-534.93z m308 422.93V191.538l-236 112v534.926m324-555.6l-16 5.658v445.706l16-5.658V282.866z m-132 115.4L594.916 466l-0.916-1.932v-77.39l144-68.164v79.752z m0 161L594.916 627l-0.916-1.932v-77.39l144-68.164v79.752z m-314-95.54l-0.916 1.93L280 397.852v-79.838l144 68.236v77.474z m0 161.17l-0.916 1.932L280 559.022v-79.836l144 68.236v77.472z"
        p-id="9676"
      ></path>
    </svg>
  );
}

export function IconEmployees(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <circle cx="17.5" cy="9.5" r="2.6" />
      <path d="M15.5 14.5a4.5 4.5 0 0 1 5 4.6" />
    </svg>
  );
}

export function IconWorld(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 4 5.5 4 9s-1.5 6.5-4 9" />
      <path d="M12 3c-2.5 2.5-4 5.5-4 9s1.5 6.5 4 9" />
      <path d="M5 6.5h14" />
      <path d="M5 17.5h14" />
    </svg>
  );
}

/** Generic app/grid icon used by mini apps without a custom icon. */
export function IconApp(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </svg>
  );
}

export function IconChatProduct(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 6h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8l-2.5 2.5V14H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" />
      <path
        d="M8 11h10a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1h-2.5L14 20.5V18H8a2 2 0 0 1-2-2v-.5"
        opacity="0.45"
      />
    </svg>
  );
}

export function IconGear(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7.1 5l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </svg>
  );
}

export function IconSearch(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}

/** Funnel: the tag-filter entry of the list filter bar. */
export function IconFilter(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M4 5h16l-6.4 7.6V19l-3.2-1.8v-4.6L4 5Z" />
    </svg>
  );
}

export function IconPlus(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={2}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconSend(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={2.2}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function IconAttach(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={2}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconImage(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

export function IconFile(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function IconFolder(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function IconCamera(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

export function IconTrash(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

export function IconStar({
  filled = false,
  ...props
}: IconProps & { filled?: boolean }): React.JSX.Element {
  return (
    <svg
      {...base({
        ...props,
        fill: filled ? "currentColor" : "none",
        strokeWidth: filled ? 1 : 1.7,
      })}
    >
      <path d="M12 3.2 14.7 8.7 20.7 9.6 16.3 13.9 17.4 19.9 12 17 6.6 19.9 7.7 13.9 3.3 9.6 9.3 8.7 Z" />
    </svg>
  );
}

export function IconCheck(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={2}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Mirror of `IconChevronDown` (used by the session "previous message" jump). */
export function IconChevronUp(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

/** Bulleted list (used by the root-chat "my messages" jump). */
export function IconList(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4.5 6h.01" />
      <path d="M4.5 12h.01" />
      <path d="M4.5 18h.01" />
    </svg>
  );
}

/** "Open" affordance: an arrow leaving its box (used by the image card). */
export function IconOpen(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </svg>
  );
}

/**
 * Raised-palm "stop" glyph used by the Halt button.
 *
 * Path data is taken verbatim from Tabler Icons' `hand-stop`
 * (https://tabler.io/icons — MIT licence) so the silhouette matches the
 * reference exactly; only the project's `base()` stroke conventions are applied.
 */
export function IconHalt(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5" />
      <path d="M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5" />
      <path d="M14 5.5a1.5 1.5 0 0 1 3 0v6.5" />
      <path d="M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47" />
    </svg>
  );
}

export function IconX(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function IconKey(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

export function IconCopy(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function IconHelp(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.35-1 .9-1 1.7v.3" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </svg>
  );
}

/** Statistics: three rounded bars of increasing height. */
export function IconStats(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <rect x="4" y="13" width="4" height="7" rx="2" />
      <rect x="10" y="8.5" width="4" height="11.5" rx="2" />
      <rect x="16" y="4" width="4" height="16" rx="2" />
    </svg>
  );
}

/** Clock face — scheduled tasks / cron jobs. */
export function IconClock(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

/** Pencil — edit. */
export function IconEdit(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} strokeWidth={1.8}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/** Solid play triangle — run now. */
export function IconPlay(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M8 5.5v13l11-6.5Z" />
    </svg>
  );
}
