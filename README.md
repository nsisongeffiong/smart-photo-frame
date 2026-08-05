# smart-photo-frame

A photo frame for an iPad that is too old to run the Home Assistant frontend.

An iPad on iOS 12.5.7 cannot render the Home Assistant UI at all — the modern
frontend needs JavaScript features that Safari 12 does not have. This service
sits in the middle: a small Node process on a public VPS polls Home Assistant
itself, over Tailscale, and serves the iPad a plain static page containing no
credentials and no modern syntax.

