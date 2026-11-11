// The few line icons the page uses, drawn in the text's colour.
const paths = {
  back: <path d="M15 5l-7 7 7 7" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  image: <><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  more: <><circle cx="5.5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18.5" cy="12" r="1.2" fill="currentColor" /></>,
};

export function Icon(p: { name: keyof typeof paths; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`flex-none fill-none stroke-current stroke-[1.6] ${p.className ?? "size-[1em]"}`} strokeLinecap="round" strokeLinejoin="round">
      {paths[p.name]}
    </svg>
  );
}
