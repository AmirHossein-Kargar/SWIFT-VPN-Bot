// * 🗂️ Models
import { randomBytes } from "node:crypto";
import User from "../models/User.js";

function generateReferralCode() {
  return `SWIFT-${randomBytes(4).toString("hex").toUpperCase()}`;
}
import keyboard from "../keyboards/mainKeyboard.js";
import handleProfile from "./message/handleProfile.js";

const handleContact = async (bot, msg, afterVerify) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // If the message does not contain a contact, prompt the user to share their phone number
  if (!msg.contact) {
    const requestContactKeyboard = {
      reply_markup: {
        keyboard: [
          [
            {
              text: "📞 ارسال شماره من",
              request_contact: true,
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };
    await bot.sendMessage(
      chatId,
      "📞 لطفاً شماره تلفن خود را ارسال کنید:",
      requestContactKeyboard
    );
    return;
  }

  const phoneNumber = msg.contact.phone_number;

  // اعتبارسنجی شماره موبایل
  if (!phoneNumber || typeof phoneNumber !== "string") {
    await bot.sendMessage(
      chatId,
      "❌ شماره موبایل نامعتبر است. لطفاً دوباره تلاش کنید.",
      keyboard
    );
    return;
  }

  // بررسی فرمت شماره موبایل (حداقل 10 رقم)
  const cleanPhone = phoneNumber.replace(/[^\d]/g, "");
  if (cleanPhone.length < 10) {
    await bot.sendMessage(
      chatId,
      "❌ شماره موبایل نامعتبر است. لطفاً شماره صحیح را وارد کنید.",
      keyboard
    );
    return;
  }

  try {
    let user = await User.findOne({ telegramId: userId });

    if (!user) {
      // ایجاد کاربر جدید با error handling
      try {
        user = await User.create({
          firstName: msg.from.first_name || "",
          lastName: msg.from.last_name || "",
          username: msg.from.username || "",
          telegramId: userId,
          balance: 0,
          successfulPayments: 0,
          totalServices: 0,
          phoneNumber: phoneNumber,
          referralCode: generateReferralCode(),
          lastActivityAt: new Date(),
        });

        await bot.sendMessage(
          chatId,
          "✅ احراز هویت شما با موفقیت انجام شد",
          keyboard
        );
      } catch (createError) {
        console.error("Error creating user:", createError);

        // بررسی اینکه آیا کاربر قبلاً ایجاد شده یا نه
        if (createError.code === 11000) {
          // Duplicate key error
          user = await User.findOne({ telegramId: userId });
          if (user && !user.phoneNumber) {
            user.phoneNumber = phoneNumber;
            await user.save();
            await bot.sendMessage(
              chatId,
              "✅ شماره تلفن شما با موفقیت به‌روزرسانی شد.",
              keyboard
            );
          } else {
            await bot.sendMessage(
              chatId,
              "❌ خطا در ثبت اطلاعات. لطفاً دوباره تلاش کنید.",
              keyboard
            );
          }
        } else {
          await bot.sendMessage(
            chatId,
            "❌ خطا در ثبت اطلاعات. لطفاً دوباره تلاش کنید.",
            keyboard
          );
        }
        return;
      }
    } else if (!user.phoneNumber) {
      // به‌روزرسانی شماره تلفن کاربر موجود
      try {
        user.phoneNumber = phoneNumber;
        if (!user.referralCode) user.referralCode = generateReferralCode();
        user.lastActivityAt = new Date();
        await user.save();
        await bot.sendMessage(
          chatId,
          "✅ شماره تلفن شما با موفقیت به‌روزرسانی شد.",
          keyboard
        );
      } catch (updateError) {
        console.error("Error updating user phone:", updateError);
        await bot.sendMessage(
          chatId,
          "❌ خطا در به‌روزرسانی شماره تلفن. لطفاً دوباره تلاش کنید.",
          keyboard
        );
        return;
      }
    } else {
      // شماره تلفن قبلاً ثبت شده
      await bot.sendMessage(
        chatId,
        "ℹ️ شماره تلفن شما قبلاً ثبت شده است.",
        keyboard
      );
      if (afterVerify) {
        await afterVerify();
      } else {
        await handleProfile(bot, chatId, userId);
      }
      return;
    }

    // اجرای callback بعد از احراز هویت موفق
    if (afterVerify) {
      await afterVerify();
    }
  } catch (error) {
    console.error("Error in handleContact:", error);
    await bot.sendMessage(
      chatId,
      "❌ خطا در احراز هویت. لطفاً دوباره تلاش کنید.",
      keyboard
    );
  }
};

export default handleContact;
