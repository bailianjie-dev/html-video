---
name: album-scroll-story
zh_name: "Scroll Story Album"
en_name: "Scroll Story Album"
emoji: "album"
description: "Interactive electronic album: mobile vertical scroll, desktop next/previous paging, photo or material driven."
zh_description: "Interactive electronic album: mobile vertical scroll, desktop next/previous paging, photo or material driven."
category: presentation
scenario: album
aspect_hint: "1080x1920 mobile-first, also works at 16:9"
featured: 25
recommended: 8
tags: ["album", "gallery", "interactive", "mobile", "photos", "story"]
example_id: sample-album-scroll-story
example_name: "Company or memory album"
example_format: markdown
example_tagline: "Swipe on mobile, click next on desktop"
example_desc: "A standalone HTML album with cover, pages, media slots, page counter, dots, and keyboard navigation."
od:
  mode: html
  surface: interactive
  scenario: album
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Scroll Story Album template to turn my materials into an interactive electronic album. Make 4-6 pages, use uploaded images when available, keep every page concise, support mobile down-scroll and desktop next/previous navigation, and return one complete standalone HTML file."
---

Use this template when the user asks for an electronic album, photo album, company album, event recap, portfolio sequence, or a mobile browsable page-by-page story.

Required behavior:
- Keep it as one complete standalone HTML document.
- The first screen is the album itself, not a marketing landing page.
- Mobile interaction: vertical scroll with scroll-snap; each album page fills one viewport.
- Desktop interaction: visible previous/next controls, page dots, keyboard support for ArrowDown/ArrowRight/PageDown and ArrowUp/ArrowLeft/PageUp.
- Use uploaded image/material paths in the media slots when available. If an uploaded asset is an HTML file, extract its meaningful text and visual structure into album pages rather than embedding a broken external page.
- Prefer 4-6 pages unless the user asks for a different length.
- Put concise editable text in elements with `data-hv-text` attributes so Studio can edit it later.
- Tag every replaceable `<img>` (and any inline `background-image` photo slot) with a stable `data-hv-image` key (for example `page_01.photo`, `page_02.photo`) so Studio can swap user uploads after generation. Do not leave media slots unmarked.
- Avoid lorem ipsum and generic filler. Every page should use the user's described topic, assets, brand, names, numbers, or event details.

Page structure:
- Cover: album title, subtitle, context line.
- Middle pages: one strong title, one short caption, one media slot or visual composition.
- Closing page: summary, date/source line, or call-to-action.

Visual guidance:
- Mobile-first, high contrast, readable at phone size.
- Use a balanced palette, not a single-hue wash.
- Keep controls clear and stable; do not let text overlap controls or images.
- Uploaded photos should be set with `object-fit: cover` or as contained images when inspection matters.
