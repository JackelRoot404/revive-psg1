# Customer-supplied Play-enabled system image

Revive does not host or redistribute the Play-enabled LineageOS system image.
The signed release manifest identifies one exact archive from its original
publisher using its HTTPS instructions page, filename pattern, archive byte
size and SHA-256. It also pins the exact expanded system image path, byte size
and SHA-256.

During installation the desktop app opens the signed instructions page and
asks the owner to select the archive they downloaded. It accepts only a regular
ZIP or XZ file matching every signed property. Extraction is bounded to the
signed expanded size; ZIP extraction reads only the exact signed member and
never joins an archive-controlled path to the filesystem. The expanded system
image is hashed again before the installer can use it as the manifest's sole
`system` flash artifact.

Customer-supplied Google APK bundles are not accepted. Private download URLs
are issued only for `delivery: "private"` artifacts such as vbmeta and Revive
diagnostics. A customer-supplied system artifact has no Spaces object key and
is never uploaded to Revive infrastructure.
