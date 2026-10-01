import unittest
from unittest.mock import Mock

from api.main import MySQLConnectionAdapter, normalize_query_for_database


class MysqlConfigCompatibilityTest(unittest.TestCase):
    def test_mysql_connection_commits_successful_context(self) -> None:
        connection = Mock()
        adapter = MySQLConnectionAdapter(connection)

        adapter.__exit__(None, None, None)

        connection.commit.assert_called_once_with()
        connection.rollback.assert_not_called()
        connection.close.assert_called_once_with()

    def test_mysql_connection_rolls_back_failed_context(self) -> None:
        connection = Mock()
        adapter = MySQLConnectionAdapter(connection)

        adapter.__exit__(RuntimeError, RuntimeError(), None)

        connection.rollback.assert_called_once_with()
        connection.commit.assert_not_called()
        connection.close.assert_called_once_with()

    def test_question_mark_placeholders_are_converted_for_mysql(self) -> None:
        query, params = normalize_query_for_database(
            "SELECT * FROM users WHERE email = ? AND id = ?",
            ("user@example.com", "abc123"),
        )
        self.assertEqual(query, "SELECT * FROM users WHERE email = %s AND id = %s")
        self.assertEqual(params, ("user@example.com", "abc123"))


if __name__ == "__main__":
    unittest.main()
