# iPhone test, 10 lines (private preview, synthetic data)

1. In the Railway dashboard open the Seatback service, then Variables, and add `DEMO_ACCESS_TOKEN` with a long random value (24+ characters). Generate it on your computer with `openssl rand -hex 16` (32 characters) or your password manager's generator. Never paste it into chat.
2. Open Settings for the service, Networking, and generate the public domain if there is none.
3. Build your link: `https://<your-domain>.up.railway.app/?access=<your DEMO_ACCESS_TOKEN>`. Send it only to yourself (Notes or Messages to self).
4. On the iPhone, open the link in Safari ONCE. It redirects to the plain address and keeps you signed in with a cookie; the token is no longer in the address bar.
5. You should see a red PRIVATE PREVIEW bar and the pill SYNTHETIC DATA. If you see "Private preview. Open the access link", the token or link is wrong.
6. Tap the button "Minneapolis to Orlando" under Judge mode: the page scrolls to the answer; the build form stays closed.
7. Check: the "What you are looking at" box, the yellow "Synthetic example" note, and "synthetic" badges on every title. Open "How it works" and "Honest limits".
8. Safari is the reliable way to use the demo. Add to Home Screen is optional (Share, Add to Home Screen, Add): the icon opens full screen with no address bar, the sign-in cookie lasts 7 days, and the icon may not share Safari's cookie. If the icon asks for access, you cannot type the link there: open the access link in Safari again (step 4), delete the icon and add it again, or just keep using Safari.
9. To stop access at once: change `DEMO_ACCESS_TOKEN` to a new value (old links die) or remove the public domain. To end everything: delete the Railway service and project.
10. Send back: what you saw on screen, anything cut off or too small, and how long the first load took.
