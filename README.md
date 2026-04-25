# codex-remote

WARNING: THIS IS MOSTLY VIBECODED (with human checking, ofc)
WARNING: THIS IS IN BETA (V1)

<img width="1501" height="820" alt="ss" src="https://github.com/user-attachments/assets/f3971bbc-05dc-4077-a6c6-da8955093042" />

If that scares you, you need not read any further.

if ye decide to sail the seas:

Here's what we got so far:

- have codex run remotely on your server, with t3code as a web ui (literally a full agent IDE embedded into the web)
- have your phone run codex stuff on the web
- create new projects, basically full codex pipeline from any browser (also claude, but only tested with codex, i'll make a config file one day). 

--- crazy stuff
- you can forward your LOCAL codex stuff to the cloud and access from your phone. (e.g. you run a prompt and you can accept on your phone from 10 miles away, or literally continue the whole thing there while ur pc runs it).
- you can push your entire repo and your chat/tool history to the cloud and pick it up there.


TODO/BIG BUGS:
If you use nginx, i think there's some special configuration for sending large files over http. gotta figure that out too.


GENERAL NOTES:
I know this has been done before, but there is no first-party solution for Codex (yet). now i can also add my own stuff to it. it'll become opinionated over time.


you also need a linux vps, or be willing to port forward. I haven't tested this with Cloudflare tunnelling yet. anything that can run docker should be able to use this repo. 

Big thanks to: https://github.com/pingdotgg/t3code
My entire UI is built off of that (MIT Licensed)
