/* @ds-bundle: {"format":3,"namespace":"PrivOSDesignSystem_b10843","components":[],"sourceHashes":{"ui_kits/app/shell.jsx":"5c09e804f5d4","ui_kits/app/ui.jsx":"5a865d3881a8","ui_kits/app/views.jsx":"601ddb7789a3","ui_kits/marketing/hero.jsx":"2c55763b4947","ui_kits/marketing/pricing.jsx":"1a1ff4403365","ui_kits/marketing/sections.jsx":"416bde8e758a","ui_kits/marketing/ui.jsx":"7bf9c9580b89"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.PrivOSDesignSystem_b10843 = window.PrivOSDesignSystem_b10843 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// ui_kits/app/shell.jsx
try { (() => {
// PrivOS App — shell: Sidebar + Topbar

function Sidebar({
  active,
  onNav
}) {
  const groups = [{
    label: 'Workspace',
    items: [['chat', 'Chat'], ['table', 'Smart Lists'], ['document', 'Documents'], ['bot', 'AI Agents']]
  }, {
    label: 'Platform',
    items: [['extension', 'MCP Apps'], ['beaker', 'Sandbox'], ['settings', 'Settings']]
  }];
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 248,
      flexShrink: 0,
      background: 'var(--privos-navy)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      borderRight: '1px solid var(--border-dark)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 18px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: `${PRIVOS_BRAND}favicon-color.svg`,
    style: {
      width: 26,
      height: 26
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff',
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 17,
      letterSpacing: '-0.01em'
    }
  }, "PrivOS"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontSize: 10,
      fontWeight: 700,
      color: 'var(--privos-navy)',
      background: 'var(--privos-gold)',
      padding: '2px 7px',
      borderRadius: 999
    }
  }, "SCALE")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      overflowY: 'auto',
      flex: 1
    }
  }, groups.map((g, gi) => /*#__PURE__*/React.createElement("div", {
    key: gi,
    style: {
      marginTop: gi ? 18 : 4
    }
  }, g.label && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '.12em',
      textTransform: 'uppercase',
      color: 'var(--navy-300)',
      padding: '4px 10px 8px'
    }
  }, g.label), g.items.map(([ic, label]) => {
    const on = active === label;
    return /*#__PURE__*/React.createElement("button", {
      key: label,
      onClick: () => onNav(label),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        width: '100%',
        textAlign: 'left',
        border: 'none',
        cursor: 'pointer',
        borderRadius: 8,
        padding: '9px 10px',
        fontFamily: 'var(--font-body)',
        fontSize: 14,
        fontWeight: on ? 600 : 500,
        marginBottom: 1,
        background: on ? 'rgba(60,130,230,.16)' : 'transparent',
        color: on ? '#fff' : 'var(--navy-200)',
        transition: 'background .14s ease'
      },
      onMouseEnter: e => {
        if (!on) e.currentTarget.style.background = 'rgba(255,255,255,.05)';
      },
      onMouseLeave: e => {
        if (!on) e.currentTarget.style.background = 'transparent';
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: ic,
      size: 19,
      color: on ? 'var(--privos-blue-soft)' : 'var(--navy-300)'
    }), label);
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12,
      borderTop: '1px solid var(--border-dark)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 8px',
      borderRadius: 10,
      background: 'rgba(255,255,255,.04)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      height: 32,
      borderRadius: '50%',
      background: 'var(--privos-gradient)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontWeight: 700,
      fontSize: 13,
      color: 'var(--privos-navy)'
    }
  }, "AL"), /*#__PURE__*/React.createElement("div", {
    style: {
      lineHeight: 1.2,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#fff',
      fontSize: 13,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, "Ada Lovelace"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--navy-300)',
      fontSize: 11,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, "Acme workspace")), /*#__PURE__*/React.createElement(Icon, {
    name: "arrow-up-down",
    size: 16,
    color: "var(--navy-300)",
    style: {
      marginLeft: 'auto'
    }
  }))));
}
function Topbar({
  title,
  crumb
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 60,
      flexShrink: 0,
      borderBottom: '1px solid var(--border-1)',
      background: 'var(--bg-surface)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 24px',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--fg-3)',
      fontWeight: 500,
      whiteSpace: 'nowrap'
    }
  }, crumb), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 18,
      letterSpacing: '-0.01em',
      color: 'var(--fg-1)'
    }
  }, title)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      background: 'var(--bg-canvas)',
      border: '1px solid var(--border-1)',
      borderRadius: 999,
      padding: '7px 14px',
      width: 240
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 16,
    color: "var(--fg-3)"
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Search\u2026",
    style: {
      border: 'none',
      background: 'transparent',
      outline: 'none',
      fontFamily: 'var(--font-body)',
      fontSize: 13,
      width: '100%',
      color: 'var(--fg-1)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--fg-3)'
    }
  }, "\u2318K")), /*#__PURE__*/React.createElement("button", {
    style: {
      width: 38,
      height: 38,
      borderRadius: '50%',
      border: '1px solid var(--border-1)',
      background: 'var(--bg-surface)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "bell",
    size: 18,
    color: "var(--fg-2)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 8,
      right: 9,
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: 'var(--privos-gold)',
      border: '1.5px solid #fff'
    }
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "md",
    icon: "add"
  }, "Invite")));
}
Object.assign(window, {
  Sidebar,
  Topbar
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/shell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/ui.jsx
try { (() => {
// PrivOS App — shared primitives (light product surfaces)
const PRIVOS_ICONS = '../../assets/icons/';
const PRIVOS_BRAND = '../../assets/brand/';
const __iconCache = {};
function Icon({
  name,
  size = 20,
  color,
  style
}) {
  const [svg, setSvg] = React.useState(__iconCache[name] || null);
  React.useEffect(() => {
    let alive = true;
    if (__iconCache[name]) {
      setSvg(__iconCache[name]);
      return;
    }
    fetch(`${PRIVOS_ICONS}${name}.svg`).then(r => r.text()).then(txt => {
      let t = txt.replace(/stroke="#[0-9A-Fa-f]{3,8}"/g, 'stroke="currentColor"').replace(/fill="#[0-9A-Fa-f]{3,8}"/g, 'fill="currentColor"').replace(/<svg /, '<svg width="100%" height="100%" ');
      __iconCache[name] = t;
      if (alive) setSvg(t);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [name]);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      width: size,
      height: size,
      color: color || 'currentColor',
      flexShrink: 0,
      ...style
    },
    dangerouslySetInnerHTML: {
      __html: svg || ''
    }
  });
}
function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  onClick,
  style
}) {
  const base = {
    fontFamily: 'var(--font-body)',
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: 'var(--radius-pill)',
    border: '1.5px solid transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    letterSpacing: '-0.01em',
    whiteSpace: 'nowrap',
    transition: 'all .15s ease'
  };
  const sizes = {
    sm: {
      fontSize: 13,
      padding: '6px 12px'
    },
    md: {
      fontSize: 14,
      padding: '9px 16px'
    }
  };
  const [h, setH] = React.useState(false);
  const variants = {
    primary: {
      background: 'var(--privos-gradient-vert)',
      color: 'var(--privos-navy)',
      fontWeight: 700,
      boxShadow: h ? 'var(--shadow-glow-gold)' : 'none',
      filter: h ? 'brightness(1.03)' : 'none'
    },
    blue: {
      background: h ? 'var(--privos-blue-deep)' : 'var(--privos-blue)',
      color: '#fff'
    },
    light: {
      background: h ? 'var(--navy-50)' : '#fff',
      color: 'var(--fg-1)',
      borderColor: 'var(--border-2)'
    },
    ghost: {
      background: h ? 'var(--bg-sunken)' : 'transparent',
      color: 'var(--fg-2)'
    }
  };
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => setH(false),
    style: {
      ...base,
      ...sizes[size],
      ...variants[variant],
      ...style
    }
  }, icon && /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: size === 'sm' ? 15 : 17
  }), children, iconRight && /*#__PURE__*/React.createElement(Icon, {
    name: iconRight,
    size: 16
  }));
}
function Chip({
  children,
  tone = 'info'
}) {
  const tones = {
    ok: {
      bg: 'var(--status-success-bg)',
      fg: 'var(--status-success)'
    },
    info: {
      bg: 'var(--status-info-bg)',
      fg: 'var(--privos-blue)'
    },
    warn: {
      bg: 'var(--status-warning-bg)',
      fg: '#9a7100'
    },
    err: {
      bg: 'var(--status-danger-bg)',
      fg: 'var(--status-danger)'
    },
    neutral: {
      bg: 'var(--navy-100)',
      fg: 'var(--navy-600)'
    }
  }[tone];
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 10px',
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      background: tones.bg,
      color: tones.fg
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: tones.fg
    }
  }), children);
}
Object.assign(window, {
  Icon,
  Button,
  Chip,
  PRIVOS_ICONS,
  PRIVOS_BRAND
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/ui.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/views.jsx
try { (() => {
// PrivOS App — main views: Chat, SmartLists, Agents, Settings

const Card = ({
  children,
  style
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-1)',
    borderRadius: 14,
    boxShadow: 'var(--shadow-sm)',
    ...style
  }
}, children);
const SectionLabel = ({
  children
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '.1em',
    textTransform: 'uppercase',
    color: 'var(--fg-3)',
    marginBottom: 14
  }
}, children);

// ---------- CHAT (the core workspace view) ----------
function Chat() {
  const [msgs, setMsgs] = React.useState([{
    who: 'Jordan Lee',
    ini: 'JL',
    t: '9:24',
    body: 'New lead just came in from Acme Corp — can we score and route it?'
  }, {
    agent: true,
    who: 'Sales Agent',
    t: '9:24',
    body: 'Scored 92/100 (enterprise, high intent). Assigned to Priya, moved to Qualified, and drafted a personalized outreach.',
    actions: ['Approve & send', 'Edit draft']
  }, {
    who: 'Priya Nair',
    ini: 'PN',
    t: '9:25',
    body: 'Looks great. Approving now.'
  }]);
  const [draft, setDraft] = React.useState('');
  const send = () => {
    if (!draft.trim()) return;
    setMsgs(m => [...m, {
      who: 'You',
      ini: 'Y<',
      t: 'now',
      body: draft
    }]);
    setDraft('');
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '24px 28px',
      display: 'flex',
      flexDirection: 'column',
      gap: 20
    }
  }, msgs.map((m, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 38,
      height: 38,
      borderRadius: '50%',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: m.agent ? 'var(--privos-gradient-vert)' : 'var(--navy-200)',
      color: 'var(--privos-navy)',
      fontWeight: 700,
      fontSize: 13
    }
  }, m.agent ? /*#__PURE__*/React.createElement(Icon, {
    name: "bot",
    size: 20,
    color: "var(--privos-navy)"
  }) : m.ini), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 700,
      color: 'var(--fg-1)'
    }
  }, m.who), m.agent && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      color: 'var(--privos-navy)',
      background: 'var(--privos-gold)',
      padding: '2px 7px',
      borderRadius: 999
    }
  }, "AGENT"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, m.t)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      lineHeight: 1.55,
      color: 'var(--fg-2)',
      marginTop: 4,
      maxWidth: 640
    }
  }, m.body), m.actions && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm"
  }, m.actions[0]), /*#__PURE__*/React.createElement(Button, {
    variant: "light",
    size: "sm"
  }, m.actions[1])))))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 28px 22px',
      borderTop: '1px solid var(--border-1)',
      background: 'var(--bg-surface)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      border: '1px solid var(--border-2)',
      borderRadius: 12,
      padding: '8px 10px 8px 16px'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "attach",
    size: 18,
    color: "var(--fg-3)"
  }), /*#__PURE__*/React.createElement("input", {
    value: draft,
    onChange: e => setDraft(e.target.value),
    onKeyDown: e => e.key === 'Enter' && send(),
    placeholder: "Message #sales\u2026  (@ to mention an agent)",
    style: {
      border: 'none',
      outline: 'none',
      flex: 1,
      fontFamily: 'var(--font-body)',
      fontSize: 14,
      color: 'var(--fg-1)',
      background: 'transparent'
    }
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    iconRight: "send",
    onClick: send
  }, "Send"))));
}

// ---------- SMART LISTS (pipeline table) ----------
function SmartLists() {
  const rows = [['Acme Corp', 'Enterprise', 'Qualified', 'info', 'Priya N.', '92'], ['Globex', 'Mid-market', 'Outreach', 'warn', 'Sales Agent', '78'], ['Initech', 'Enterprise', 'Won', 'ok', 'Daniel K.', '95'], ['Umbrella', 'SMB', 'New', 'neutral', 'Unassigned', '61'], ['Soylent', 'Mid-market', 'Qualified', 'info', 'Priya N.', '84']];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-1)',
      borderRadius: 999,
      padding: '8px 14px',
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 16,
    color: "var(--fg-3)"
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Search the sales pipeline\u2026",
    style: {
      border: 'none',
      background: 'transparent',
      outline: 'none',
      fontFamily: 'var(--font-body)',
      fontSize: 13,
      width: '100%',
      color: 'var(--fg-1)'
    }
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "light",
    icon: "filter"
  }, "Filter"), /*#__PURE__*/React.createElement(Button, {
    variant: "light",
    icon: "Kanban"
  }, "Board"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    icon: "add"
  }, "New record")), /*#__PURE__*/React.createElement(Card, {
    style: {
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: 'var(--bg-canvas)',
      textAlign: 'left'
    }
  }, ['Account', 'Segment', 'Stage', 'Owner', 'Score', ''].map((h, i) => /*#__PURE__*/React.createElement("th", {
    key: i,
    style: {
      padding: '11px 18px',
      fontWeight: 600,
      color: 'var(--fg-3)',
      fontSize: 12,
      borderBottom: '1px solid var(--border-1)'
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, rows.map((r, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    style: {
      borderBottom: i < rows.length - 1 ? '1px solid var(--border-1)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '13px 18px',
      fontWeight: 600,
      color: 'var(--fg-1)'
    }
  }, r[0]), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '13px 18px',
      color: 'var(--fg-2)'
    }
  }, r[1]), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '13px 18px'
    }
  }, /*#__PURE__*/React.createElement(Chip, {
    tone: r[3]
  }, r[2])), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '13px 18px',
      color: 'var(--fg-2)'
    }
  }, r[4]), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '13px 18px',
      fontFamily: 'var(--font-mono)',
      fontWeight: 600,
      color: 'var(--fg-1)'
    }
  }, r[5]), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '13px 18px',
      textAlign: 'right'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "more",
    size: 18,
    color: "var(--fg-3)"
  }))))))));
}

// ---------- AI AGENTS ----------
function Agents() {
  const agents = [{
    ic: 'arrow-trending',
    name: 'Sales Agent',
    room: '# sales',
    desc: 'Lead scoring, pipeline automation',
    on: true
  }, {
    ic: 'chat',
    name: 'Support Agent',
    room: '# support',
    desc: 'Ticket triage, auto-reply',
    on: true
  }, {
    ic: 'person-multiple',
    name: 'HR Agent',
    room: '# people',
    desc: 'Onboarding, compliance',
    on: false
  }, {
    ic: 'box',
    name: 'Ops Agent',
    room: '# ops',
    desc: 'Inventory, reporting',
    on: true
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(2,1fr)',
      gap: 16
    }
  }, agents.map((a, i) => /*#__PURE__*/React.createElement(Card, {
    key: i,
    style: {
      padding: 20,
      display: 'flex',
      gap: 16,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 48,
      borderRadius: 12,
      background: 'var(--privos-navy)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: a.ic,
    size: 24,
    color: "var(--privos-gold)"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 16,
      color: 'var(--fg-1)'
    }
  }, a.name), /*#__PURE__*/React.createElement(Chip, {
    tone: a.on ? 'ok' : 'neutral'
  }, a.on ? 'Running' : 'Paused')), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--fg-2)',
      marginTop: 4
    }
  }, a.desc), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 10,
      fontSize: 12,
      color: 'var(--fg-3)',
      fontFamily: 'var(--font-mono)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "lock",
    size: 13,
    color: "var(--fg-3)"
  }), " room-scoped \xB7 ", a.room))))));
}

// ---------- SETTINGS ----------
function Settings() {
  const [toggles, setToggles] = React.useState({
    mfa: true,
    audit: true,
    hitl: true
  });
  const T = ({
    k,
    label,
    desc
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      padding: '16px 0',
      borderBottom: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: 'var(--fg-1)'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--fg-2)',
      marginTop: 2
    }
  }, desc)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setToggles(s => ({
      ...s,
      [k]: !s[k]
    })),
    style: {
      width: 44,
      height: 26,
      borderRadius: 999,
      border: 'none',
      cursor: 'pointer',
      padding: 3,
      background: toggles[k] ? 'var(--privos-blue)' : 'var(--navy-200)',
      transition: 'background .16s ease',
      display: 'flex',
      justifyContent: toggles[k] ? 'flex-end' : 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: '#fff',
      boxShadow: 'var(--shadow-sm)'
    }
  })));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 28,
      maxWidth: 720
    }
  }, /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: '6px 24px 20px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '18px 0 6px'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Security & governance")), /*#__PURE__*/React.createElement(T, {
    k: "mfa",
    label: "Require multi-factor auth",
    desc: "Enforce hardware MFA for every member on sign-in."
  }), /*#__PURE__*/React.createElement(T, {
    k: "audit",
    label: "Immutable audit log",
    desc: "Sign and retain every human and agent action for compliance export."
  }), /*#__PURE__*/React.createElement(T, {
    k: "hitl",
    label: "Human-in-the-loop by default",
    desc: "New agents pause for approval before acting on production data."
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 18,
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "light"
  }, "Discard"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary"
  }, "Save changes")));
}
function Placeholder({
  name
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 28
    }
  }, /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 48,
      textAlign: 'center',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "board",
    size: 36,
    color: "var(--navy-200)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      fontSize: 15,
      fontWeight: 600,
      color: 'var(--fg-2)'
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      marginTop: 4
    }
  }, "This surface is intentionally left as a stub in the kit.")));
}
Object.assign(window, {
  Chat,
  SmartLists,
  Agents,
  Settings,
  Placeholder
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/views.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/hero.jsx
try { (() => {
// PrivOS Marketing — Hero with workspace (teams + AI agents) visual

function WorkspaceMock() {
  const rooms = [['chat', '# general', false], ['chat', '# sales', true], ['chat', '# support', false], ['bot', 'agents', false]];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 16,
      overflow: 'hidden',
      background: '#fff',
      boxShadow: '0 40px 80px -20px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06)',
      transform: 'perspective(1600px) rotateY(-9deg) rotateX(3deg)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 38,
      background: 'var(--privos-navy)',
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      padding: '0 14px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: '#FF5F57'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: '#FEBC2E'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: '#28C840'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 10,
      color: 'var(--navy-300)',
      fontFamily: 'var(--font-mono)',
      fontSize: 11
    }
  }, "workspace.privos.ai")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: 296
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 132,
      background: 'var(--privos-navy)',
      padding: '14px 10px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
      padding: '0 4px'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: `${PRIVOS_BRAND}favicon-color.svg`,
    style: {
      width: 20,
      height: 20
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff',
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 13
    }
  }, "Acme")), rooms.map(([ic, label, on], i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 8px',
      borderRadius: 7,
      background: on ? 'rgba(60,130,230,.22)' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: ic,
    size: 14,
    color: on ? 'var(--privos-blue-soft)' : 'var(--navy-300)'
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: on ? 600 : 500,
      color: on ? '#fff' : 'var(--navy-200)'
    }
  }, label)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: 16,
      background: 'var(--bg-canvas)',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 28,
      height: 28,
      borderRadius: '50%',
      background: 'var(--navy-200)',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11,
      fontWeight: 700,
      color: 'var(--privos-navy)'
    }
  }, "JL"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: 'var(--fg-1)'
    }
  }, "Jordan ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-3)',
      fontWeight: 500
    }
  }, "9:24")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--fg-2)',
      marginTop: 3,
      lineHeight: 1.45
    }
  }, "New lead from Acme Corp \u2014 can we score and route it?"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 28,
      height: 28,
      borderRadius: '50%',
      background: 'var(--privos-gradient-vert)',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "bot",
    size: 16,
    color: "var(--privos-navy)"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: 'var(--fg-1)',
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, "Sales Agent", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9,
      fontWeight: 700,
      color: 'var(--privos-navy)',
      background: 'var(--privos-gold)',
      padding: '1px 6px',
      borderRadius: 999
    }
  }, "AGENT")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--fg-2)',
      marginTop: 3,
      lineHeight: 1.45
    }
  }, "Scored ", /*#__PURE__*/React.createElement("b", null, "92/100"), ". Assigned to Priya, moved to ", /*#__PURE__*/React.createElement("b", null, "Qualified"), ", drafted outreach."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 600,
      color: 'var(--privos-blue)',
      background: '#fff',
      border: '1px solid var(--border-1)',
      padding: '5px 10px',
      borderRadius: 7
    }
  }, "Approve"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 600,
      color: 'var(--fg-2)',
      background: '#fff',
      border: '1px solid var(--border-1)',
      padding: '5px 10px',
      borderRadius: 7
    }
  }, "Edit")))))));
}
function Hero() {
  const stats = [['6-in-1', 'tools replaced'], ['75%', 'SaaS cost cut'], ['300%', 'productivity boost']];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      position: 'relative',
      overflow: 'hidden',
      background: 'radial-gradient(120% 90% at 80% -10%, #0A2B4D 0%, var(--privos-navy) 55%)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      backgroundImage: 'radial-gradient(rgba(255,255,255,.05) 1px, transparent 1px)',
      backgroundSize: '28px 28px',
      maskImage: 'linear-gradient(180deg, #000 0%, transparent 70%)',
      WebkitMaskImage: 'linear-gradient(180deg, #000 0%, transparent 70%)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      position: 'relative',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 48,
      alignItems: 'center',
      padding: '64px 32px 76px'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 14px',
      borderRadius: 999,
      border: '1px solid var(--border-dark-strong)',
      background: 'rgba(255,255,255,.04)',
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "sparkle",
    size: 15,
    color: "var(--privos-gold)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--navy-200)',
      fontSize: 13,
      fontWeight: 500
    }
  }, "The AI Operating System for Enterprise")), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 54,
      lineHeight: 1.06,
      letterSpacing: '-0.03em',
      color: '#fff',
      margin: 0
    }
  }, "Where teams &", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--privos-gold)'
    }
  }, "AI agents"), " collaborate."), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--navy-200)',
      fontSize: 18,
      lineHeight: 1.6,
      maxWidth: 480,
      margin: '22px 0 0',
      fontWeight: 500
    }
  }, "Replace 5\u20137 SaaS tools with one platform. Chat, data, files, and autonomous agents \u2014 deployed on your servers, cloud, or fully air-gapped."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      marginTop: 30
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    iconRight: "arrow-right"
  }, "Request a demo"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "lg"
  }, "Explore the platform")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 26,
      marginTop: 34
    }
  }, stats.map(([n, l]) => /*#__PURE__*/React.createElement("div", {
    key: l
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 22,
      color: '#fff'
    }
  }, n), /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--navy-300)',
      fontSize: 12,
      marginTop: 2
    }
  }, l))))), /*#__PURE__*/React.createElement(WorkspaceMock, null)));
}
Object.assign(window, {
  Hero,
  WorkspaceMock
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/hero.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/pricing.jsx
try { (() => {
// PrivOS Marketing — Security band, Economics, CTA, Footer

function Security() {
  const items = [['shield-keyhole', 'Self-hosted'], ['server', 'Air-gapped'], ['lock', 'Room-level isolation'], ['history', 'Complete audit trail'], ['person-access', 'Permission boundaries'], ['globe', 'Data sovereignty']];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--bg-canvas)',
      padding: '84px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 640
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, null, "Enterprise security"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 38,
      lineHeight: 1.12,
      letterSpacing: '-0.02em',
      color: 'var(--fg-1)',
      margin: '12px 0 0'
    }
  }, "Built for regulated industries."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 16,
      lineHeight: 1.6,
      color: 'var(--fg-2)',
      margin: '14px 0 0'
    }
  }, "Healthcare, legal, finance, government \u2014 PrivOS meets compliance requirements ordinary SaaS cannot. GDPR, HIPAA, and SOC 2 ready.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 14,
      marginTop: 36
    }
  }, items.map(([ic, label], i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      background: '#fff',
      border: '1px solid var(--border-1)',
      borderRadius: 12,
      padding: '16px 18px',
      boxShadow: 'var(--shadow-xs)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 40,
      borderRadius: 10,
      background: 'var(--privos-navy)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: ic,
    size: 20,
    color: "var(--privos-gold)"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: 'var(--fg-1)'
    }
  }, label))))));
}
function Economics() {
  const rows = [['25 users', '$24,300/yr', '~$15,000+'], ['50 users', '$48,600/yr', '~$30,000+'], ['200 users', '$194,400/yr', '~$120,000+'], ['500 users', '$486,000/yr', '~$300,000+'], ['1,000 users', '$972,000/yr', '~$600,000+']];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--privos-navy)',
      padding: '84px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      maxWidth: 680,
      margin: '0 auto'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    color: "var(--privos-gold)"
  }, "The economics"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 40,
      lineHeight: 1.1,
      letterSpacing: '-0.025em',
      color: '#fff',
      margin: '12px 0 0'
    }
  }, "Cut SaaS costs ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--privos-gold)'
    }
  }, "75%"), ".", /*#__PURE__*/React.createElement("br", null), "Boost your team ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--privos-gold)'
    }
  }, "300%"), "."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 16,
      lineHeight: 1.6,
      color: 'var(--navy-200)',
      margin: '16px auto 0',
      maxWidth: 540
    }
  }, "Every SaaS tool charges per user, per month \u2014 the bigger you grow, the more you bleed. PrivOS consolidates 6+ tools into one AI-powered platform.")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 40,
      background: 'var(--navy-surface)',
      border: '1px solid var(--border-dark)',
      borderRadius: 18,
      overflow: 'hidden',
      maxWidth: 820,
      marginLeft: 'auto',
      marginRight: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      padding: '14px 24px',
      borderBottom: '1px solid var(--border-dark)'
    }
  }, ['Team size', 'Fragmented SaaS · $81/user/mo', 'Annual savings'].map((h, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '.08em',
      textTransform: 'uppercase',
      color: 'var(--navy-300)',
      textAlign: i === 2 ? 'right' : 'left'
    }
  }, h))), rows.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      padding: '15px 24px',
      alignItems: 'center',
      borderBottom: i < rows.length - 1 ? '1px solid var(--border-dark)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: '#fff'
    }
  }, r[0]), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--navy-200)',
      fontFamily: 'var(--font-mono)'
    }
  }, r[1]), /*#__PURE__*/React.createElement("span", {
    className: "privos-gradient-text",
    style: {
      fontSize: 15,
      fontWeight: 700,
      textAlign: 'right',
      fontFamily: 'var(--font-mono)'
    }
  }, r[2]))))));
}
function CTA() {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--bg-canvas)',
      padding: '80px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      overflow: 'hidden',
      borderRadius: 24,
      background: 'radial-gradient(120% 120% at 85% 0%, #0A2B4D 0%, var(--privos-navy) 60%)',
      padding: '56px 48px',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: `${PRIVOS_BRAND}favicon-color.svg`,
    style: {
      position: 'absolute',
      left: -40,
      bottom: -60,
      width: 280,
      opacity: .09
    }
  }), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 40,
      letterSpacing: '-0.025em',
      color: '#fff',
      margin: 0,
      position: 'relative'
    }
  }, "Deploy your ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--privos-gold)'
    }
  }, "Enterprise AI OS.")), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--navy-200)',
      fontSize: 17,
      margin: '14px auto 28px',
      maxWidth: 520,
      position: 'relative'
    }
  }, "See PrivOS in action. We'll demo the full platform and map it to your enterprise requirements \u2014 in under 30 minutes."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      justifyContent: 'center',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    iconRight: "arrow-right"
  }, "Request a demo"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "lg"
  }, "Book a discovery call")))));
}
function Footer() {
  const cols = [{
    h: 'Platform',
    items: ['Chat', 'Smart Lists', 'Documents', 'AI Agents', 'MCP Apps', 'Sandbox']
  }, {
    h: 'Solutions',
    items: ['Future of Work', 'Enterprise Security', 'Use Cases', 'The Economics']
  }, {
    h: 'Company',
    items: ['Blog', 'Book a Meeting', 'Request a Demo']
  }];
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      background: 'var(--navy-900)',
      borderTop: '1px solid var(--border-dark)',
      padding: '56px 0 36px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      display: 'grid',
      gridTemplateColumns: '1.6fr 1fr 1fr 1fr',
      gap: 32
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Logo, {
    variant: "white",
    height: 24
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--navy-400)',
      fontSize: 13,
      lineHeight: 1.6,
      margin: '16px 0 0',
      maxWidth: 260
    }
  }, "The AI Operating System for Enterprise \u2014 where teams and AI agents collaborate."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      marginTop: 18
    }
  }, ['x-twitter', 'github', 'bluesky'].map(s => /*#__PURE__*/React.createElement(Icon, {
    key: s,
    name: s,
    size: 18,
    color: "var(--navy-400)"
  })))), cols.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.h
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--navy-200)',
      fontSize: 13,
      fontWeight: 700,
      marginBottom: 14
    }
  }, c.h), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      margin: 0,
      padding: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, c.items.map(it => /*#__PURE__*/React.createElement("li", {
    key: it
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: 'var(--navy-400)',
      textDecoration: 'none',
      fontSize: 13
    }
  }, it))))))), /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      marginTop: 40,
      paddingTop: 22,
      borderTop: '1px solid var(--border-dark)',
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--navy-300)',
      fontSize: 12
    }
  }, "\xA9 2026 PrivOS. The AI Operating System for Enterprise."), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--navy-300)',
      fontSize: 12
    }
  }, "Cloud \xB7 Self-hosted \xB7 Air-gapped")));
}
Object.assign(window, {
  Security,
  Economics,
  CTA,
  Footer
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/pricing.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/sections.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// PrivOS Marketing — Nav, Collaboration, Ecosystem (six pillars)

const WRAP = {
  maxWidth: 1180,
  margin: '0 auto',
  padding: '0 32px'
};
function Nav() {
  const links = ['Platform', 'Security', 'Use Cases', 'Economics', 'Blog'];
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 50,
      background: 'rgba(0,25,48,.72)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      borderBottom: '1px solid var(--border-dark)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      height: 68,
      display: 'flex',
      alignItems: 'center',
      gap: 28
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    variant: "color",
    height: 24
  }), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      gap: 24,
      marginLeft: 12
    }
  }, links.map(l => /*#__PURE__*/React.createElement("a", {
    key: l,
    href: "#",
    style: {
      color: 'var(--navy-200)',
      textDecoration: 'none',
      fontSize: 14,
      fontWeight: 500,
      whiteSpace: 'nowrap'
    },
    onMouseEnter: e => e.target.style.color = '#fff',
    onMouseLeave: e => e.target.style.color = 'var(--navy-200)'
  }, l))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 10,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "sm",
    style: {
      color: 'var(--navy-200)'
    }
  }, "Book a meeting"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    iconRight: "arrow-right"
  }, "Request a demo"))));
}

// "Experience the future of work" — three pillars of the value prop
function Collaboration() {
  const cards = [{
    icon: 'person-multiple',
    t: 'Intuitively collaborative',
    d: 'A workspace that feels as natural as your favorite chat apps — but powered by autonomous agents working alongside your team.'
  }, {
    icon: 'server',
    t: 'Zero-friction deployment',
    d: 'No complex installs. Run on secured cloud, self-host on your infrastructure, or go fully air-gapped in your intranet.'
  }, {
    icon: 'arrow-trending',
    t: 'Limitless scalability',
    d: 'From 10 to 10,000 users. The MCP App Platform lets you build any tool your business needs, so your OS grows with you.'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--bg-canvas)',
      padding: '84px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: WRAP
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 640
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, null, "Experience the future of work"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 38,
      lineHeight: 1.12,
      letterSpacing: '-0.02em',
      color: 'var(--fg-1)',
      margin: '12px 0 0'
    }
  }, "Human + AI collaboration, in one OS."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 16,
      lineHeight: 1.6,
      color: 'var(--fg-2)',
      margin: '14px 0 0'
    }
  }, "Stop toggling between disjointed tools. PrivOS treats AI agents as full team members \u2014 sensing, thinking, and acting alongside your people.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 18,
      marginTop: 40
    }
  }, cards.map((c, i) => /*#__PURE__*/React.createElement(PillarCard, _extends({
    key: i
  }, c, {
    big: true
  }))))));
}

// "The AI Operating System Ecosystem" — six pillars
function Ecosystem() {
  const pillars = [{
    icon: 'chat',
    t: 'Chat',
    d: 'Secure team communication with channels, threads, and room-scoped isolation — private and compliant by default.'
  }, {
    icon: 'table',
    t: 'Smart List & Data',
    d: 'Flexible databases with spreadsheet and Kanban views. Run inventory, tickets, tasks, or CRM pipelines with custom fields.'
  }, {
    icon: 'document',
    t: 'Documents & Files',
    d: 'Centralized wiki and knowledge with a markdown editor, AI document parsing, and secure file sharing.'
  }, {
    icon: 'bot',
    t: 'AI Bot Agents',
    d: 'Room-scoped assistants that execute workflows — permission-bounded, with human-in-the-loop controls and event triggers.'
  }, {
    icon: 'extension',
    t: 'MCP Apps',
    d: 'Custom portals, dashboards, and integrations on the Model Context Protocol — an endlessly extensible OS.'
  }, {
    icon: 'beaker',
    t: 'Sandbox',
    d: 'Isolated execution for safe testing, experimentation, and AI-driven code execution inside the platform.'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--privos-navy)',
      padding: '84px 0',
      position: 'relative',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: `${PRIVOS_BRAND}favicon-color.svg`,
    style: {
      position: 'absolute',
      right: -90,
      top: 30,
      width: 380,
      opacity: .06
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 620
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    color: "var(--privos-gold)"
  }, "How it works"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 38,
      lineHeight: 1.12,
      letterSpacing: '-0.02em',
      color: '#fff',
      margin: '12px 0 0'
    }
  }, "The AI Operating System ecosystem."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 16,
      lineHeight: 1.6,
      color: 'var(--navy-200)',
      margin: '14px 0 0'
    }
  }, "The six pillars of PrivOS \u2014 one platform, one perimeter.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 16,
      marginTop: 40
    }
  }, pillars.map((p, i) => /*#__PURE__*/React.createElement(PillarCard, _extends({
    key: i
  }, p, {
    dark: true
  }))))));
}
function PillarCard({
  icon,
  t,
  d,
  dark,
  big
}) {
  const [hover, setHover] = React.useState(false);
  const bg = dark ? 'var(--navy-surface)' : '#fff';
  const border = dark ? '1px solid var(--border-dark)' : '1px solid var(--border-1)';
  return /*#__PURE__*/React.createElement("div", {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      position: 'relative',
      overflow: 'hidden',
      background: bg,
      border,
      borderRadius: 16,
      padding: big ? 28 : 24,
      boxShadow: dark ? 'none' : hover ? 'var(--shadow-lg)' : 'var(--shadow-sm)',
      transform: hover ? 'translateY(-4px)' : 'none',
      transition: 'transform .2s cubic-bezier(.2,.7,.2,1), box-shadow .2s ease, border-color .2s ease',
      borderColor: dark && hover ? 'var(--border-dark-strong)' : undefined
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      background: 'var(--privos-gradient)',
      opacity: hover ? 1 : 0,
      transition: 'opacity .2s ease'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 46,
      height: 46,
      borderRadius: 12,
      background: dark ? 'rgba(255,255,255,.05)' : 'var(--privos-navy)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: 22,
    color: "var(--privos-gold)"
  })), /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 700,
      fontSize: 18,
      letterSpacing: '-0.01em',
      margin: '0 0 8px',
      color: dark ? '#fff' : 'var(--fg-1)'
    }
  }, t), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      lineHeight: 1.6,
      color: dark ? 'var(--navy-200)' : 'var(--fg-2)',
      margin: 0
    }
  }, d));
}
Object.assign(window, {
  Nav,
  Collaboration,
  Ecosystem,
  PillarCard,
  WRAP
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/sections.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/ui.jsx
try { (() => {
// PrivOS Marketing — shared primitives
// Exported to window for cross-file use (Babel scoping)

const PRIVOS_ICONS = '../../assets/icons/';
const PRIVOS_BRAND = '../../assets/brand/';

// Inline-SVG icon: fetch once, recolor stroke/fill to currentColor.
const __iconCache = {};
function Icon({
  name,
  size = 20,
  color,
  style
}) {
  const [svg, setSvg] = React.useState(__iconCache[name] || null);
  React.useEffect(() => {
    let alive = true;
    if (__iconCache[name]) {
      setSvg(__iconCache[name]);
      return;
    }
    fetch(`${PRIVOS_ICONS}${name}.svg`).then(r => r.text()).then(txt => {
      let t = txt.replace(/stroke="#[0-9A-Fa-f]{3,8}"/g, 'stroke="currentColor"').replace(/fill="#[0-9A-Fa-f]{3,8}"/g, 'fill="currentColor"').replace(/<svg /, '<svg width="100%" height="100%" ');
      __iconCache[name] = t;
      if (alive) setSvg(t);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [name]);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      width: size,
      height: size,
      color: color || 'currentColor',
      flexShrink: 0,
      ...style
    },
    dangerouslySetInnerHTML: {
      __html: svg || ''
    }
  });
}
function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  onClick,
  style
}) {
  const base = {
    fontFamily: 'var(--font-body)',
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: 'var(--radius-pill)',
    border: '1.5px solid transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    letterSpacing: '-0.01em',
    whiteSpace: 'nowrap',
    transition: 'background .16s ease, color .16s ease, box-shadow .16s ease, transform .08s ease'
  };
  const sizes = {
    sm: {
      fontSize: 13,
      padding: '7px 14px'
    },
    md: {
      fontSize: 15,
      padding: '11px 20px'
    },
    lg: {
      fontSize: 16,
      padding: '14px 26px'
    }
  };
  const variants = {
    primary: {
      background: 'var(--privos-gradient-vert)',
      color: 'var(--privos-navy)',
      fontWeight: 700
    },
    blue: {
      background: 'var(--privos-blue)',
      color: '#fff'
    },
    secondary: {
      background: '#fff',
      color: 'var(--privos-navy)',
      borderColor: 'transparent'
    },
    light: {
      background: '#fff',
      color: 'var(--privos-navy)',
      borderColor: 'var(--border-2)'
    },
    ghost: {
      background: 'transparent',
      color: 'var(--fg-2)'
    }
  };
  const [hover, setHover] = React.useState(false);
  const hoverStyle = hover ? {
    primary: {
      boxShadow: 'var(--shadow-glow-gold)',
      filter: 'brightness(1.03)'
    },
    blue: {
      background: 'var(--privos-blue-deep)'
    },
    secondary: {
      background: 'var(--navy-50)'
    },
    light: {
      background: 'var(--navy-50)'
    },
    ghost: {
      background: 'var(--bg-sunken)'
    }
  }[variant] : {};
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      ...base,
      ...sizes[size],
      ...variants[variant],
      ...hoverStyle,
      ...style
    }
  }, icon && /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: size === 'sm' ? 16 : 18
  }), children, iconRight && /*#__PURE__*/React.createElement(Icon, {
    name: iconRight,
    size: size === 'sm' ? 16 : 18
  }));
}
function Eyebrow({
  children,
  color = 'var(--privos-blue)',
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '.14em',
      textTransform: 'uppercase',
      color,
      ...style
    }
  }, children);
}
function Logo({
  variant = 'color',
  height = 26
}) {
  return /*#__PURE__*/React.createElement("img", {
    src: `${PRIVOS_BRAND}logo-${variant}.svg`,
    style: {
      height,
      display: 'block'
    },
    alt: "PrivOS"
  });
}
Object.assign(window, {
  Icon,
  Button,
  Eyebrow,
  Logo,
  PRIVOS_ICONS,
  PRIVOS_BRAND
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/ui.jsx", error: String((e && e.message) || e) }); }

})();
