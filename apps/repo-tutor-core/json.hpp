#pragma once

#include <cmath>
#include <cstddef>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// M2 用的最小 JSON 子集：只覆盖 JSON-RPC 消息需要的部分。
// 它是进程边界上的工具，不属于 Core 领域。

namespace repo_tutor::json
{

struct Value
{
	enum class Type
	{
		null,
		boolean,
		number,
		string,
		array,
		object,
	};

	Type type = Type::null;
	bool boolean = false;
	double number = 0.0;
	std::string string;
	std::vector<Value> array;
	// object 用插入顺序保存，M2 的对象都很小。
	std::vector<std::pair<std::string, Value>> object;

	bool is_null() const
	{
		return type == Type::null;
	}
	bool is_bool() const
	{
		return type == Type::boolean;
	}
	bool is_number() const
	{
		return type == Type::number;
	}
	bool is_string() const
	{
		return type == Type::string;
	}
	bool is_array() const
	{
		return type == Type::array;
	}
	bool is_object() const
	{
		return type == Type::object;
	}
};

// 找对象里的成员；找不到返回 nullptr。
inline const Value* find_member(const Value& value, const std::string& key)
{
	for(const auto& entry: value.object)
	{
		if(entry.first == key)
		{
			return &entry.second;
		}
	}
	return nullptr;
}

// 取对象里的字符串成员；不存在或类型不对时返回空串。
inline std::string string_member(const Value& value, const std::string& key)
{
	const Value* member = find_member(value, key);
	return member != nullptr && member->is_string() ? member->string : std::string{};
}

// 取对象里的数字成员；不存在时返回 fallback。
inline double number_member(const Value& value, const std::string& key, double fallback = 0.0)
{
	const Value* member = find_member(value, key);
	return member != nullptr && member->is_number() ? member->number : fallback;
}

// 取对象里的数组成员；不存在时返回空数组。
inline const std::vector<Value>* array_member(const Value& value, const std::string& key)
{
	const Value* member = find_member(value, key);
	return member != nullptr && member->is_array() ? &member->array : nullptr;
}

class ParseError: public std::runtime_error
{
public:
	explicit ParseError(const std::string& what): std::runtime_error(what) {}
};

namespace detail
{

class Parser
{
public:
	explicit Parser(const std::string& text): text_(text) {}

	Value parse_document()
	{
		skip_whitespace();
		Value value = parse_value();
		skip_whitespace();
		if(position_ != text_.size())
		{
			fail("trailing characters after JSON value");
		}
		return value;
	}

private:
	[[noreturn]] void fail(const std::string& reason) const
	{
		throw ParseError(reason + " at offset " + std::to_string(position_));
	}

	bool at_end() const
	{
		return position_ >= text_.size();
	}

	char peek() const
	{
		if(at_end())
		{
			fail("unexpected end of input");
		}
		return text_[position_];
	}

	char take()
	{
		const char c = peek();
		++position_;
		return c;
	}

	void skip_whitespace()
	{
		while(!at_end())
		{
			const char c = text_[position_];
			if(c == ' ' || c == '\t' || c == '\n' || c == '\r')
			{
				++position_;
				continue;
			}
			break;
		}
	}

	void expect(char expected)
	{
		if(take() != expected)
		{
			fail(std::string("expected '") + expected + "'");
		}
	}

	Value parse_value()
	{
		switch(peek())
		{
		case '{':
			return parse_object();
		case '[':
			return parse_array();
		case '"': {
			Value value;
			value.type = Value::Type::string;
			value.string = parse_string();
			return value;
		}
		case 't':
			consume_literal("true");
			return make_boolean(true);
		case 'f':
			consume_literal("false");
			return make_boolean(false);
		case 'n':
			consume_literal("null");
			return make_null();
		default:
			return parse_number();
		}
	}

	void consume_literal(const char* literal)
	{
		const std::size_t length = std::char_traits<char>::length(literal);
		if(text_.compare(position_, length, literal) != 0)
		{
			fail("invalid literal");
		}
		position_ += length;
	}

	static Value make_boolean(bool value)
	{
		Value result;
		result.type = Value::Type::boolean;
		result.boolean = value;
		return result;
	}

	static Value make_null()
	{
		Value result;
		result.type = Value::Type::null;
		return result;
	}

	Value parse_object()
	{
		expect('{');

		Value value;
		value.type = Value::Type::object;

		skip_whitespace();
		if(peek() == '}')
		{
			take();
			return value;
		}

		while(true)
		{
			skip_whitespace();
			std::string key = parse_string();
			skip_whitespace();
			expect(':');
			skip_whitespace();
			value.object.emplace_back(std::move(key), parse_value());
			skip_whitespace();

			const char separator = take();
			if(separator == '}')
			{
				return value;
			}
			if(separator != ',')
			{
				fail("expected ',' or '}' in object");
			}
		}
	}

	Value parse_array()
	{
		expect('[');

		Value value;
		value.type = Value::Type::array;

		skip_whitespace();
		if(peek() == ']')
		{
			take();
			return value;
		}

		while(true)
		{
			skip_whitespace();
			value.array.push_back(parse_value());
			skip_whitespace();

			const char separator = take();
			if(separator == ']')
			{
				return value;
			}
			if(separator != ',')
			{
				fail("expected ',' or ']' in array");
			}
		}
	}

	std::string parse_string()
	{
		expect('"');

		std::string result;
		while(true)
		{
			const char c = take();
			if(c == '"')
			{
				return result;
			}

			if(c == '\\')
			{
				const char escaped = take();
				switch(escaped)
				{
				case '"':
					result.push_back('"');
					break;
				case '\\':
					result.push_back('\\');
					break;
				case '/':
					result.push_back('/');
					break;
				case 'b':
					result.push_back('\b');
					break;
				case 'f':
					result.push_back('\f');
					break;
				case 'n':
					result.push_back('\n');
					break;
				case 'r':
					result.push_back('\r');
					break;
				case 't':
					result.push_back('\t');
					break;
				case 'u':
					result += parse_unicode_escape();
					break;
				default:
					fail("invalid escape sequence");
				}
				continue;
			}

			if(static_cast<unsigned char>(c) < 0x20)
			{
				fail("unescaped control character in string");
			}
			result.push_back(c);
		}
	}

	// 只处理 BMP，够 M2 用。
	std::string parse_unicode_escape()
	{
		unsigned code = 0;
		for(int i = 0; i < 4; ++i)
		{
			const char hex = take();
			code <<= 4;
			if(hex >= '0' && hex <= '9')
			{
				code |= static_cast<unsigned>(hex - '0');
			}
			else if(hex >= 'a' && hex <= 'f')
			{
				code |= static_cast<unsigned>(hex - 'a' + 10);
			}
			else if(hex >= 'A' && hex <= 'F')
			{
				code |= static_cast<unsigned>(hex - 'A' + 10);
			}
			else
			{
				fail("invalid unicode escape");
			}
		}

		std::string result;
		if(code < 0x80)
		{
			result.push_back(static_cast<char>(code));
		}
		else if(code < 0x800)
		{
			result.push_back(static_cast<char>(0xC0 | (code >> 6)));
			result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
		}
		else
		{
			result.push_back(static_cast<char>(0xE0 | (code >> 12)));
			result.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
			result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
		}
		return result;
	}

	Value parse_number()
	{
		const std::size_t start = position_;
		while(!at_end())
		{
			const char c = text_[position_];
			if((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
			{
				++position_;
				continue;
			}
			break;
		}

		if(position_ == start)
		{
			fail("invalid number");
		}

		try
		{
			Value value;
			value.type = Value::Type::number;
			value.number = std::stod(text_.substr(start, position_ - start));
			return value;
		}
		catch(const std::exception&)
		{
			fail("invalid number");
		}
	}

	const std::string& text_;
	std::size_t position_ = 0;
};

} // namespace detail

inline Value parse(const std::string& text)
{
	return detail::Parser(text).parse_document();
}

inline void append_escaped_string(std::string& out, const std::string& value)
{
	out.push_back('"');
	for(const char c: value)
	{
		switch(c)
		{
		case '"':
			out += "\\\"";
			break;
		case '\\':
			out += "\\\\";
			break;
		case '\b':
			out += "\\b";
			break;
		case '\f':
			out += "\\f";
			break;
		case '\n':
			out += "\\n";
			break;
		case '\r':
			out += "\\r";
			break;
		case '\t':
			out += "\\t";
			break;
		default:
			if(static_cast<unsigned char>(c) < 0x20)
			{
				char buffer[8] = {};
				std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned char>(c));
				out += buffer;
			}
			else
			{
				out.push_back(c);
			}
		}
	}
	out.push_back('"');
}

inline void append_number(std::string& out, double value)
{
	char buffer[32] = {};
	if(value == std::floor(value) && std::abs(value) < 1e15)
	{
		std::snprintf(buffer, sizeof(buffer), "%.0f", value);
	}
	else
	{
		std::snprintf(buffer, sizeof(buffer), "%.17g", value);
	}
	out += buffer;
}

inline void serialize_to(std::string& out, const Value& value)
{
	switch(value.type)
	{
	case Value::Type::null:
		out += "null";
		break;
	case Value::Type::boolean:
		out += value.boolean ? "true" : "false";
		break;
	case Value::Type::number:
		append_number(out, value.number);
		break;
	case Value::Type::string:
		append_escaped_string(out, value.string);
		break;
	case Value::Type::array:
		out.push_back('[');
		for(std::size_t i = 0; i < value.array.size(); ++i)
		{
			if(i != 0)
			{
				out.push_back(',');
			}
			serialize_to(out, value.array[i]);
		}
		out.push_back(']');
		break;
	case Value::Type::object:
		out.push_back('{');
		for(std::size_t i = 0; i < value.object.size(); ++i)
		{
			if(i != 0)
			{
				out.push_back(',');
			}
			append_escaped_string(out, value.object[i].first);
			out.push_back(':');
			serialize_to(out, value.object[i].second);
		}
		out.push_back('}');
		break;
	}
}

inline std::string serialize(const Value& value)
{
	std::string out;
	serialize_to(out, value);
	return out;
}

} // namespace repo_tutor::json
