// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// proton-tool: CLI wrapper around go-proton-api for Proton Mail/Calendar
package main

import (
	"context"
	"fmt"
	"net/mail"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ProtonMail/gluon/rfc822"
	"github.com/ProtonMail/go-proton-api"
	"github.com/ProtonMail/gopenpgp/v2/crypto"
)

func usage() {
	fmt.Fprintf(os.Stderr, "proton-tool - Proton Mail and Calendar CLI\n\n")
	fmt.Fprintf(os.Stderr, "Usage:\n")
	fmt.Fprintf(os.Stderr, "  proton-tool whoami           Show authenticated user info\n")
	fmt.Fprintf(os.Stderr, "  proton-tool calendars        List all calendars\n")
	fmt.Fprintf(os.Stderr, "  proton-tool events           List events from default calendar\n")
	fmt.Fprintf(os.Stderr, "    --calendar-id=ID           Calendar ID (uses first if omitted)\n")
	fmt.Fprintf(os.Stderr, "    --days=N                   Look-ahead days (default: 7)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool mail             List inbox messages\n")
	fmt.Fprintf(os.Stderr, "    --limit=N                  Number of messages (default: 10)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool sent             List sent messages\n")
	fmt.Fprintf(os.Stderr, "    --limit=N                  Number of messages (default: 10)\n")
	fmt.Fprintf(os.Stderr, "    --days=N                   Only show messages from last N days (default: all)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool count-mail       Show message counts by label\n")
	fmt.Fprintf(os.Stderr, "  proton-tool read-mail        Read a specific message body\n")
	fmt.Fprintf(os.Stderr, "    --id=MSGID                 Message ID (required)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool mark-read        Mark messages as read\n")
	fmt.Fprintf(os.Stderr, "    --id=MSGID1,MSGID2,...     Message IDs (required, comma-separated)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool send-mail        Send an email\n")
	fmt.Fprintf(os.Stderr, "    --to=ADDR                  Recipient address (required, comma-separated for multiple)\n")
	fmt.Fprintf(os.Stderr, "    --cc=ADDR                  CC addresses (optional, comma-separated)\n")
	fmt.Fprintf(os.Stderr, "    --subject=TEXT              Subject line (required)\n")
	fmt.Fprintf(os.Stderr, "    --body=TEXT                 Body text (reads stdin if omitted)\n")
	fmt.Fprintf(os.Stderr, "    --html                     Send as HTML (default: plain text)\n")
	fmt.Fprintf(os.Stderr, "\nEnvironment:\n")
	fmt.Fprintf(os.Stderr, "  PROTON_USERNAME   Proton account email\n")
	fmt.Fprintf(os.Stderr, "  PROTON_PASSWORD   Proton account password\n")
	os.Exit(1)
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "Error: %s: %v\n", msg, err)
	os.Exit(1)
}

func login(ctx context.Context) (*proton.Manager, *proton.Client) {
	username := os.Getenv("PROTON_USERNAME")
	password := os.Getenv("PROTON_PASSWORD")
	if username == "" || password == "" {
		fmt.Fprintln(os.Stderr, "Error: PROTON_USERNAME and PROTON_PASSWORD must be set")
		os.Exit(1)
	}

	m := proton.New(
		proton.WithHostURL("https://mail-api.proton.me"),
		proton.WithAppVersion("web-mail@5.0.36"),
	)

	c, auth, err := m.NewClientWithLogin(ctx, username, []byte(password))
	if err != nil {
		fatal("login failed", err)
	}

	if auth.TwoFA.Enabled&proton.HasTOTP != 0 {
		fmt.Fprintln(os.Stderr, "Error: 2FA (TOTP) is enabled. This tool does not support 2FA yet.")
		c.Close()
		m.Close()
		os.Exit(1)
	}

	return m, c
}

func getArg(args []string, prefix string, defaultVal string) string {
	for _, a := range args {
		if len(a) > len(prefix) && a[:len(prefix)] == prefix {
			return a[len(prefix):]
		}
	}
	return defaultVal
}

func cmdWhoami(ctx context.Context) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	user, err := c.GetUser(ctx)
	if err != nil {
		fatal("get user", err)
	}

	fmt.Printf("Name:         %s\n", user.Name)
	fmt.Printf("DisplayName:  %s\n", user.DisplayName)
	fmt.Printf("Email:        %s\n", user.Email)
	fmt.Printf("UsedSpace:    %d bytes\n", user.UsedSpace)
	fmt.Printf("MaxSpace:     %d bytes\n", user.MaxSpace)
}

func cmdCalendars(ctx context.Context) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	calendars, err := c.GetCalendars(ctx)
	if err != nil {
		fatal("get calendars", err)
	}

	if len(calendars) == 0 {
		fmt.Println("No calendars found.")
		return
	}

	for i, cal := range calendars {
		fmt.Printf("[%d] ID: %s\n", i+1, cal.ID)
		fmt.Printf("    Name:        %s\n", cal.Name)
		fmt.Printf("    Description: %s\n", cal.Description)
		fmt.Printf("    Color:       %s\n", cal.Color)
		fmt.Println()
	}
}

func cmdEvents(ctx context.Context, args []string) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	calendarID := getArg(args, "--calendar-id=", "")
	daysStr := getArg(args, "--days=", "7")
	days, _ := strconv.Atoi(daysStr)
	if days <= 0 {
		days = 7
	}

	if calendarID == "" {
		calendars, err := c.GetCalendars(ctx)
		if err != nil {
			fatal("get calendars", err)
		}
		if len(calendars) == 0 {
			fmt.Println("No calendars found.")
			return
		}
		calendarID = calendars[0].ID
		fmt.Printf("Using calendar: %s (ID: %s)\n\n", calendars[0].Name, calendarID)
	}

	now := time.Now().UTC()
	end := now.Add(time.Duration(days) * 24 * time.Hour)

	filter := url.Values{}
	filter.Set("Start", strconv.FormatInt(now.Unix(), 10))
	filter.Set("End", strconv.FormatInt(end.Unix(), 10))

	events, err := c.GetAllCalendarEvents(ctx, calendarID, filter)
	if err != nil {
		fatal("get events", err)
	}

	if len(events) == 0 {
		fmt.Printf("No events in the next %d days.\n", days)
		return
	}

	fmt.Printf("Found %d events:\n\n", len(events))
	for i, ev := range events {
		start := time.Unix(ev.StartTime, 0).UTC()
		evEnd := time.Unix(ev.EndTime, 0).UTC()
		fmt.Printf("[%d] Event ID: %s\n", i+1, ev.ID)
		fmt.Printf("    UID:       %s\n", ev.UID)
		fmt.Printf("    Start:     %s\n", start.Format(time.RFC3339))
		fmt.Printf("    End:       %s\n", evEnd.Format(time.RFC3339))
		fmt.Printf("    Timezone:  %s / %s\n", ev.StartTimezone, ev.EndTimezone)
		fmt.Printf("    Full Day:  %v\n", bool(ev.FullDay))
		fmt.Printf("    Author:    %s\n", ev.Author)
		if len(ev.Attendees) > 0 {
			fmt.Printf("    Attendees: %d\n", len(ev.Attendees))
		}
		fmt.Println()
	}
}

func cmdMail(ctx context.Context, args []string) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	limitStr := getArg(args, "--limit=", "10")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 {
		limit = 10
	}

	filter := proton.MessageFilter{
		LabelID: "0",
	}

	messages, err := c.GetMessageMetadata(ctx, filter)
	if err != nil {
		fatal("get messages", err)
	}

	if len(messages) == 0 {
		fmt.Println("No messages in inbox.")
		return
	}

	if len(messages) > limit {
		messages = messages[:limit]
	}

	fmt.Printf("Inbox (%d messages shown):\n\n", len(messages))
	for i, msg := range messages {
		t := time.Unix(msg.Time, 0).UTC()
		fmt.Printf("[%d] %s\n", i+1, msg.Subject)
		if msg.Sender != nil {
			fmt.Printf("    From:    %s <%s>\n", msg.Sender.Name, msg.Sender.Address)
		}
		fmt.Printf("    Date:    %s\n", t.Format(time.RFC3339))
		fmt.Printf("    ID:      %s\n", msg.ID)
		fmt.Printf("    Unread:  %v\n", bool(msg.Unread))
		fmt.Println()
	}
}

func cmdSent(ctx context.Context, args []string) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	limitStr := getArg(args, "--limit=", "10")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 {
		limit = 10
	}

	daysStr := getArg(args, "--days=", "0")
	days, _ := strconv.Atoi(daysStr)

	filter := proton.MessageFilter{
		LabelID: "2",
	}

	messages, err := c.GetMessageMetadata(ctx, filter)
	if err != nil {
		fatal("get sent messages", err)
	}

	if len(messages) == 0 {
		fmt.Println("No sent messages.")
		return
	}

	if days > 0 {
		cutoff := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
		var filtered []proton.MessageMetadata
		for _, msg := range messages {
			if time.Unix(msg.Time, 0).UTC().After(cutoff) {
				filtered = append(filtered, msg)
			}
		}
		messages = filtered
	}

	if len(messages) > limit {
		messages = messages[:limit]
	}

	fmt.Printf("Sent (%d messages shown):\n\n", len(messages))
	for i, msg := range messages {
		t := time.Unix(msg.Time, 0).UTC()
		fmt.Printf("[%d] %s\n", i+1, msg.Subject)
		if len(msg.ToList) > 0 {
			var toAddrs []string
			for _, addr := range msg.ToList {
				toAddrs = append(toAddrs, fmt.Sprintf("%s <%s>", addr.Name, addr.Address))
			}
			fmt.Printf("    To:      %s\n", strings.Join(toAddrs, ", "))
		}
		fmt.Printf("    Date:    %s\n", t.Format(time.RFC3339))
		fmt.Printf("    ID:      %s\n", msg.ID)
		fmt.Println()
	}
}

func cmdCountMail(ctx context.Context) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	count, err := c.CountMessages(ctx)
	if err != nil {
		fatal("count messages", err)
	}

	fmt.Printf("Total messages: %d\n", count)
}

func unlockKeys(ctx context.Context, c *proton.Client, password []byte) (
	user proton.User,
	addr proton.Address,
	addrKR *crypto.KeyRing,
) {
	var err error

	user, err = c.GetUser(ctx)
	if err != nil {
		fatal("get user", err)
	}

	salts, err := c.GetSalts(ctx)
	if err != nil {
		fatal("get salts", err)
	}

	saltedKeyPass, err := salts.SaltForKey(password, user.Keys.Primary().ID)
	if err != nil {
		fatal("salt key passphrase", err)
	}

	addresses, err := c.GetAddresses(ctx)
	if err != nil {
		fatal("get addresses", err)
	}

	for _, a := range addresses {
		if bool(a.Send) {
			addr = a
			break
		}
	}
	if addr.ID == "" {
		fmt.Fprintln(os.Stderr, "Error: no send-capable address found")
		os.Exit(1)
	}

	_, addrKRs, err := proton.Unlock(user, addresses, saltedKeyPass, nil)
	if err != nil {
		fatal("unlock keys", err)
	}

	addrKR = addrKRs[addr.ID]
	if addrKR == nil {
		fmt.Fprintln(os.Stderr, "Error: could not unlock address keyring")
		os.Exit(1)
	}

	return user, addr, addrKR
}

func parseAddressList(s string) []*mail.Address {
	var addrs []*mail.Address
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		addrs = append(addrs, &mail.Address{Address: part})
	}
	return addrs
}

func cmdReadMail(ctx context.Context, args []string) {
	msgID := getArg(args, "--id=", "")
	if msgID == "" {
		fmt.Fprintln(os.Stderr, "Error: --id=MSGID is required")
		os.Exit(1)
	}

	password := []byte(os.Getenv("PROTON_PASSWORD"))
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	_, _, addrKR := unlockKeys(ctx, c, password)

	msg, err := c.GetMessage(ctx, msgID)
	if err != nil {
		fatal("get message", err)
	}

	body, err := msg.Decrypt(addrKR)
	if err != nil {
		fatal("decrypt message", err)
	}

	if bool(msg.Unread) {
		if err := c.MarkMessagesRead(ctx, msgID); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to mark as read: %v\n", err)
		}
	}

	fmt.Printf("Subject: %s\n", msg.Subject)
	if msg.Sender != nil {
		fmt.Printf("From:    %s <%s>\n", msg.Sender.Name, msg.Sender.Address)
	}
	fmt.Printf("Date:    %s\n", time.Unix(msg.Time, 0).UTC().Format(time.RFC3339))
	fmt.Printf("Type:    %s\n", msg.MIMEType)
	fmt.Printf("ID:      %s\n", msg.ID)
	fmt.Println()
	fmt.Println(string(body))
}

func cmdMarkRead(ctx context.Context, args []string) {
	idsStr := getArg(args, "--id=", "")
	if idsStr == "" {
		fmt.Fprintln(os.Stderr, "Error: --id=MSGID1,MSGID2,... is required")
		os.Exit(1)
	}

	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	ids := strings.Split(idsStr, ",")
	for i := range ids {
		ids[i] = strings.TrimSpace(ids[i])
	}

	var failed []string
	for _, id := range ids {
		if id == "" {
			continue
		}
		if err := c.MarkMessagesRead(ctx, id); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to mark %s as read: %v\n", id, err)
			failed = append(failed, id)
		}
	}

	marked := len(ids) - len(failed)
	fmt.Printf("Marked %d/%d messages as read.\n", marked, len(ids))
	if len(failed) > 0 {
		fmt.Printf("Failed: %s\n", strings.Join(failed, ", "))
	}
}

func cmdSendMail(ctx context.Context, args []string) {
	toStr := getArg(args, "--to=", "")
	ccStr := getArg(args, "--cc=", "")
	subject := getArg(args, "--subject=", "")
	bodyText := getArg(args, "--body=", "")

	if toStr == "" {
		fmt.Fprintln(os.Stderr, "Error: --to=ADDR is required")
		os.Exit(1)
	}
	if subject == "" {
		fmt.Fprintln(os.Stderr, "Error: --subject=TEXT is required")
		os.Exit(1)
	}

	if bodyText == "" {
		data, err := os.ReadFile("/dev/stdin")
		if err != nil {
			fatal("read stdin", err)
		}
		bodyText = string(data)
	}

	isHTML := false
	for _, a := range args {
		if a == "--html" {
			isHTML = true
		}
	}

	mimeType := rfc822.TextPlain
	if isHTML {
		mimeType = rfc822.TextHTML
	}

	toList := parseAddressList(toStr)
	ccList := parseAddressList(ccStr)

	password := []byte(os.Getenv("PROTON_PASSWORD"))
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	_, addr, addrKR := unlockKeys(ctx, c, password)

	draft, err := c.CreateDraft(ctx, addrKR, proton.CreateDraftReq{
		Message: proton.DraftTemplate{
			Subject:  subject,
			Sender:   &mail.Address{Address: addr.Email},
			ToList:   toList,
			CCList:   ccList,
			Body:     bodyText,
			MIMEType: mimeType,
		},
	})
	if err != nil {
		fatal("create draft", err)
	}

	fmt.Printf("Draft created: %s\n", draft.ID)

	allRecipients := make(map[string]proton.SendPreferences)

	for _, rcpt := range append(toList, ccList...) {
		email := rcpt.Address

		pubKeys, recipientType, err := c.GetPublicKeys(ctx, email)
		if err != nil {
			fatal("get public keys for "+email, err)
		}

		if recipientType == proton.RecipientTypeInternal && len(pubKeys) > 0 {
			rcptKR, err := pubKeys.GetKeyRing()
			if err != nil {
				fatal("build keyring for "+email, err)
			}
			allRecipients[email] = proton.SendPreferences{
				Encrypt:          true,
				PubKey:           rcptKR,
				SignatureType:    proton.DetachedSignature,
				EncryptionScheme: proton.InternalScheme,
				MIMEType:         mimeType,
			}
		} else {
			allRecipients[email] = proton.SendPreferences{
				Encrypt:          false,
				SignatureType:    proton.NoSignature,
				EncryptionScheme: proton.ClearScheme,
				MIMEType:         mimeType,
			}
		}
	}

	var sendReq proton.SendDraftReq

	internalPrefs := make(map[string]proton.SendPreferences)
	clearPrefs := make(map[string]proton.SendPreferences)

	for email, prefs := range allRecipients {
		switch prefs.EncryptionScheme {
		case proton.InternalScheme:
			internalPrefs[email] = prefs
		default:
			clearPrefs[email] = prefs
		}
	}

	if len(internalPrefs) > 0 {
		if err := sendReq.AddTextPackage(addrKR, bodyText, mimeType, internalPrefs, nil); err != nil {
			fatal("add internal package", err)
		}
	}

	if len(clearPrefs) > 0 {
		if err := sendReq.AddTextPackage(addrKR, bodyText, mimeType, clearPrefs, nil); err != nil {
			fatal("add clear package", err)
		}
	}

	sent, err := c.SendDraft(ctx, draft.ID, sendReq)
	if err != nil {
		fatal("send draft", err)
	}

	fmt.Printf("Email sent successfully!\n")
	fmt.Printf("  Message ID: %s\n", sent.ID)
	fmt.Printf("  Subject:    %s\n", sent.Subject)
	fmt.Printf("  To:         %s\n", toStr)
	if ccStr != "" {
		fmt.Printf("  CC:         %s\n", ccStr)
	}
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "whoami":
		cmdWhoami(ctx)
	case "calendars":
		cmdCalendars(ctx)
	case "events":
		cmdEvents(ctx, args)
	case "mail":
		cmdMail(ctx, args)
	case "sent":
		cmdSent(ctx, args)
	case "count-mail":
		cmdCountMail(ctx)
	case "read-mail":
		cmdReadMail(ctx, args)
	case "mark-read":
		cmdMarkRead(ctx, args)
	case "send-mail":
		cmdSendMail(ctx, args)
	case "--help", "-h", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", cmd)
		usage()
	}
}
